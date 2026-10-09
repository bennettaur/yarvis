import { tool } from "ai";
import { z } from "zod";
import { fence, newNonce, untrustedWarning } from "../lib/fencing.ts";
import {
  type BrowserBridge,
  type BrowserCommand,
  browserBridge,
  type CommandResult,
} from "./bridge.ts";

/**
 * Browser tools for the chat model, answered by the Yarvis Chrome extension in
 * whatever profile it is installed in. The point is reading a site the user
 * already has open (Slack, a ticket board, a doc) and moving around inside it —
 * so it can read one channel, open the next and scroll back through history.
 *
 * The extension is what holds the line: it refuses to leave the tab's origin,
 * refuses controls that send or change things, and has no way to type. Nothing
 * here is trusted to enforce that on its own.
 */

/** Default and ceiling for a page's text, so one tall page can't fill the context. */
const DEFAULT_PAGE_CHARS = 20_000;
const MAX_PAGE_CHARS = 60_000;

const tabSchema = z.object({
  id: z.number(),
  windowId: z.number(),
  active: z.boolean(),
  title: z.string(),
  url: z.string(),
});

const elementsSchema = z.object({
  url: z.string(),
  title: z.string(),
  /** Set when a site adapter (e.g. "slack") shaped the listing. */
  adapter: z.string().optional(),
  elements: z.array(
    z.object({
      ref: z.number(),
      kind: z.string(),
      label: z.string(),
      href: z.string().optional(),
      channelId: z.string().optional(),
      openUrl: z.string().optional(),
    }),
  ),
  truncated: z.boolean().optional(),
  /** How many matches were left out because clicking them would be refused. */
  skipped: z.number().optional(),
});

const inspectSchema = z.object({
  url: z.string(),
  title: z.string(),
  count: z.number(),
  matches: z.array(
    z.object({
      ref: z.number(),
      tag: z.string(),
      attributes: z.record(z.string(), z.string()),
      text: z.string(),
      visible: z.boolean(),
      rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
      clickable: z.boolean(),
      refused: z.string().optional(),
      children: z.array(z.string()),
      childCount: z.number(),
    }),
  ),
});

/** Where the tab ended up after a click, scroll or navigation. */
const stateSchema = z.object({
  url: z.string(),
  title: z.string(),
  /** What actually received the click (or hover), which may sit inside the chosen element. */
  clicked: z.object({ tag: z.string(), label: z.string() }).optional(),
  hovered: z.object({ tag: z.string(), label: z.string() }).optional(),
  navigated: z.boolean().optional(),
  changed: z.boolean().optional(),
  note: z.string().max(500).optional(),
  atTop: z.boolean().optional(),
  atBottom: z.boolean().optional(),
});

const pageSchema = z.object({
  url: z.string(),
  title: z.string(),
  adapter: z.string().optional(),
  adapterNote: z.string().max(300).optional(),
  selection: z.string().optional(),
  text: z.string(),
  truncated: z.boolean().optional(),
});

/**
 * A listed URL keeps its origin and path but not its query or fragment: those
 * carry session tokens and OAuth codes, and picking a tab needs neither.
 */
function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** A shape that already wrote its own text is passed through; anything else is JSON. */
function asText(shaped: unknown): string {
  return typeof shaped === "string" ? shaped : JSON.stringify(shaped);
}

/**
 * A listing as one line per element, the layout accessibility-tree snapshots
 * use: `- treeitem "agentic-intake" [ref=24] channelId=C0…`. The same elements as
 * JSON cost nearly three times the tokens, almost all of it repeated keys.
 */
function elementLines(page: z.infer<typeof elementsSchema>): string {
  const head = [
    `url: ${withoutQuery(page.url)}`,
    `title: ${page.title}`,
    ...(page.adapter ? [`adapter: ${page.adapter}`] : []),
  ];
  const lines = page.elements.map((el) => {
    const extras = [
      el.href ? `→ ${withoutQuery(el.href)}` : "",
      el.channelId ? `channelId=${el.channelId}` : "",
      el.openUrl ? `openUrl=${el.openUrl}` : "",
    ].filter(Boolean);
    // page.js already keeps kind to a plain word; checked again here because it
    // is printed unquoted.
    const kind = /^[a-z]+$/.test(el.kind) ? el.kind : "element";
    return `- ${kind} ${JSON.stringify(el.label)} [ref=${el.ref}]${extras.length ? ` ${extras.join(" ")}` : ""}`;
  });
  const tail = [
    ...(page.truncated ? ["(more elements than maxElements; narrow with text or selector)"] : []),
    ...(page.skipped ? [`(${page.skipped} left out because Yarvis won't click them)`] : []),
  ];
  return [...head, ...lines, ...tail].join("\n");
}

function withCleanUrl<T extends { url: string }>(state: T): T {
  return { ...state, url: withoutQuery(state.url) };
}

/** What a tool says when the browser side failed; the model can relay it. */
function failure(result: CommandResult): { error: string } {
  return { error: result.error ?? "The browser returned an error." };
}

async function ask(bridge: BrowserBridge, command: BrowserCommand, profile?: string) {
  try {
    return await bridge.request(command, { profile });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function buildBrowserTools(bridge: BrowserBridge = browserBridge) {
  /**
   * Asks the browser, validates the answer and fences it. Everything the browser
   * sends back is text a website wrote (labels, titles, addresses), so it all
   * goes through the same nonce fence.
   */
  async function askFenced<T>(
    command: BrowserCommand,
    profile: string | undefined,
    schema: z.ZodType<T>,
    tag: string,
    shape: (data: T) => unknown = (data) => data,
  ) {
    const result = await ask(bridge, command, profile);
    if (!result.ok) return failure(result);
    const parsed = schema.safeParse(result.data);
    if (!parsed.success)
      return { error: "The browser sent back something in an unexpected shape." };
    const nonce = newNonce();
    return {
      notice: untrustedWarning(nonce, tag),
      [tag.replace("browser-", "")]: fence(asText(shape(parsed.data)), nonce, tag),
    };
  }

  const profileField = z
    .string()
    .max(64)
    .optional()
    .describe(
      "Chrome profile name as list_browser_tabs shows it (e.g. 'work'). Needed only when more than one profile is connected.",
    );

  const tabIdField = z
    .number()
    .int()
    .optional()
    .describe("Tab id from list_browser_tabs; default is the active tab");

  return {
    list_browser_tabs: tool({
      description:
        "List the tabs open in the user's Chrome, grouped by Chrome profile (the user names each one in the extension, e.g. 'work' or 'personal'). Each tab has an id, window, title, URL and whether it is active. Use it to find the tab to read, e.g. the Slack tab in the work profile. Omit profile to list every connected profile.",
      inputSchema: z.object({ profile: profileField }),
      execute: async ({ profile }) => {
        const targets =
          profile === undefined ? bridge.profiles() : [{ id: profile, name: profile }];
        if (targets.length === 0) return failure(await ask(bridge, { type: "list_tabs" }));

        const groups = await Promise.all(
          targets.map(async (target) => {
            const result = await ask(bridge, { type: "list_tabs" }, target.id);
            if (!result.ok) return { profile: target.name, error: failure(result).error };
            const tabs = z.array(tabSchema).safeParse(result.data);
            if (!tabs.success) return { profile: target.name, error: "unexpected shape" };
            return {
              profile: target.name,
              tabs: tabs.data.map((tab) => ({ ...tab, url: withoutQuery(tab.url) })),
            };
          }),
        );
        // A named profile that failed is the whole answer; say so plainly.
        const only = groups.length === 1 ? groups[0] : undefined;
        if (only && "error" in only && only.error) return { error: only.error };

        // Profile names are the user's, but titles and URLs are written by each site.
        const nonce = newNonce();
        return {
          notice: untrustedWarning(nonce, "browser-tabs"),
          tabs: fence(JSON.stringify(groups), nonce, "browser-tabs"),
        };
      },
    }),
    read_browser_page: tool({
      description:
        "Read the visible text of a page open in the user's Chrome — the active tab by default, or a tab id from list_browser_tabs. Returns the URL, title, any text the user has selected, and the page text. Long pages such as chat channels only include what is loaded, so scroll_browser_page up to load older messages. Read-only.",
      inputSchema: z.object({
        profile: profileField,
        tabId: tabIdField,
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(MAX_PAGE_CHARS)
          .default(DEFAULT_PAGE_CHARS)
          .describe("Cap on the page text returned"),
      }),
      execute: async ({ profile, tabId, maxChars }) => {
        // The extension already caps the text; this is the sidecar's own bound.
        return askFenced(
          { type: "read_page", tabId, maxChars },
          profile,
          pageSchema,
          "browser-page",
          (page) => ({
            url: page.url,
            title: page.title,
            ...(page.adapter ? { adapter: page.adapter } : {}),
            ...(page.adapterNote ? { adapterNote: page.adapterNote } : {}),
            ...(page.selection ? { selection: page.selection.slice(0, maxChars) } : {}),
            text: page.text.slice(0, maxChars),
            truncated: Boolean(page.truncated) || page.text.length > maxChars,
          }),
        );
      },
    }),
    list_browser_elements: tool({
      description:
        "List what can be clicked or scrolled on a page in the user's Chrome: links, buttons, tabs, sidebar items (each with a numeric ref), and scrollable panels (kind 'scroll'). Use the refs with click_browser_element and scroll_browser_page. Refs are only valid until the page changes, so list again after a click. Controls that send or change things (send, delete, leave, ...) are left out. Use text to find one thing by name, or selector (CSS) to list what a selector matches when the usual listing misses it. On Slack, conversations carry a channelId and an openUrl that navigate_browser_tab can load.",
      inputSchema: z.object({
        profile: profileField,
        tabId: tabIdField,
        maxElements: z.number().int().min(10).max(300).default(150),
        text: z
          .string()
          .max(100)
          .optional()
          .describe("Only list elements whose label contains this (case-insensitive)"),
        selector: z
          .string()
          .max(300)
          .optional()
          .describe("CSS selector to list instead of the usual links and buttons"),
      }),
      execute: ({ profile, tabId, maxElements, text, selector }) =>
        askFenced(
          { type: "list_elements", tabId, maxElements, text, selector },
          profile,
          elementsSchema,
          "browser-elements",
          // Query strings carry session tokens, and a ref is all a click needs.
          elementLines,
        ),
    }),
    inspect_browser_page: tool({
      description:
        "Look at how part of a page in the user's Chrome is built, to work out why a listing or click didn't do what you expected. Returns up to `limit` elements matching a CSS selector: tag, id/class/role/aria-*/data-* attributes, a text snippet, size and position, whether it sits in something clickable, whether a click would be refused and why, and its children. Each match gets a ref for click_browser_element or scroll_browser_page. Read-only.",
      inputSchema: z.object({
        profile: profileField,
        tabId: tabIdField,
        selector: z.string().min(1).max(300).describe("CSS selector, e.g. '[role=treeitem]'"),
        limit: z.number().int().min(1).max(30).default(10),
      }),
      execute: ({ profile, tabId, selector, limit }) =>
        askFenced(
          { type: "inspect", tabId, selector, limit },
          profile,
          inspectSchema,
          "browser-inspect",
          (found) => ({
            ...found,
            url: withoutQuery(found.url),
          }),
        ),
    }),
    click_browser_element: tool({
      description:
        "Click a link, tab or sidebar item on a page in the user's Chrome — by ref from list_browser_elements or inspect_browser_page, or by a CSS selector — for example to open another Slack channel. It only works inside the site the tab is already on: a link to another site is refused, and so is anything that sends, posts, deletes or changes something. It cannot type. Returns the tab's URL and title afterwards, and changed: false when neither moved — then the click may not have worked, so read_browser_page before saying it did.",
      inputSchema: z
        .object({
          profile: profileField,
          tabId: tabIdField,
          ref: z
            .number()
            .int()
            .optional()
            .describe("Ref from the latest list_browser_elements or inspect_browser_page"),
          selector: z
            .string()
            .max(300)
            .optional()
            .describe("CSS selector for the element, instead of a ref"),
          index: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Which match of selector to click, from 0 (default 0). Ignored with ref."),
          mode: z
            .enum(["center", "direct", "hover"])
            .default("center")
            .describe(
              "center: click where a person would, the element under its middle (default). direct: send the click to the element itself, for when something covers it. hover: only move the pointer over it, to reveal a menu or buttons.",
            ),
          waitMs: z
            .number()
            .int()
            .min(0)
            .max(5000)
            .optional()
            .describe(
              "How long to let the page react before reporting, for slow pages (at least 900, the default)",
            ),
        })
        .refine((input) => (input.ref === undefined) !== (input.selector === undefined), {
          message: "give either ref or selector",
        }),
      execute: ({ profile, tabId, ref, selector, index, mode, waitMs }) =>
        askFenced(
          { type: "click", tabId, ref, selector, index, mode, waitMs },
          profile,
          stateSchema,
          "browser-state",
          withCleanUrl,
        ),
    }),
    scroll_browser_page: tool({
      description:
        "Scroll the page, or one scrollable panel (a 'scroll' ref from list_browser_elements), in the user's Chrome. Scrolling a chat channel up loads older messages. Reports whether it is now at the top or bottom.",
      inputSchema: z.object({
        profile: profileField,
        tabId: tabIdField,
        ref: z.number().int().optional().describe("A 'scroll' ref; omit to scroll the whole page"),
        direction: z.enum(["up", "down", "top", "bottom"]),
      }),
      execute: ({ profile, tabId, ref, direction }) =>
        askFenced(
          { type: "scroll", tabId, ref, direction },
          profile,
          stateSchema,
          "browser-state",
          withCleanUrl,
        ),
    }),
    navigate_browser_tab: tool({
      description:
        "Load an address in a tab of the user's Chrome. It must be on the same site (origin) the tab is already on; any other site is refused. Prefer clicking a link when there is one.",
      inputSchema: z.object({
        profile: profileField,
        tabId: tabIdField,
        url: z
          .string()
          .url()
          .max(2000)
          .refine((u) => /^https?:/i.test(u), "must be an http(s) address"),
      }),
      execute: ({ profile, tabId, url }) =>
        askFenced(
          { type: "navigate", tabId, url },
          profile,
          stateSchema,
          "browser-state",
          withCleanUrl,
        ),
    }),
  };
}
