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
  elements: z.array(
    z.object({
      ref: z.number(),
      kind: z.string(),
      label: z.string(),
      href: z.string().optional(),
    }),
  ),
  truncated: z.boolean().optional(),
});

/** Where the tab ended up after a click, scroll or navigation. */
const stateSchema = z.object({
  url: z.string(),
  title: z.string(),
  navigated: z.boolean().optional(),
  atTop: z.boolean().optional(),
  atBottom: z.boolean().optional(),
});

const pageSchema = z.object({
  url: z.string(),
  title: z.string(),
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
      [tag.replace("browser-", "")]: fence(JSON.stringify(shape(parsed.data)), nonce, tag),
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
            ...(page.selection ? { selection: page.selection.slice(0, maxChars) } : {}),
            text: page.text.slice(0, maxChars),
            truncated: Boolean(page.truncated) || page.text.length > maxChars,
          }),
        );
      },
    }),
    list_browser_elements: tool({
      description:
        "List what can be clicked or scrolled on a page in the user's Chrome: links, buttons, tabs, sidebar items (each with a numeric ref), and scrollable panels (kind 'scroll'). Use the refs with click_browser_element and scroll_browser_page. Refs are only valid until the page changes, so list again after a click. Controls that send or change things (send, delete, leave, ...) are left out.",
      inputSchema: z.object({
        profile: profileField,
        tabId: tabIdField,
        maxElements: z.number().int().min(10).max(300).default(150),
      }),
      execute: ({ profile, tabId, maxElements }) =>
        askFenced(
          { type: "list_elements", tabId, maxElements },
          profile,
          elementsSchema,
          "browser-elements",
          // Query strings carry session tokens, and a ref is all a click needs.
          (page) => ({
            ...page,
            url: withoutQuery(page.url),
            elements: page.elements.map((el) => ({
              ...el,
              href: el.href && withoutQuery(el.href),
            })),
          }),
        ),
    }),
    click_browser_element: tool({
      description:
        "Click a link, tab or sidebar item on a page in the user's Chrome, by ref from list_browser_elements — for example to open another Slack channel. It only works inside the site the tab is already on: a link to another site is refused, and so is anything that sends, posts, deletes or changes something. It cannot type. Returns the tab's URL and title afterwards; then read_browser_page to see the result.",
      inputSchema: z.object({
        profile: profileField,
        tabId: tabIdField,
        ref: z.number().int().describe("Ref from the latest list_browser_elements"),
      }),
      execute: ({ profile, tabId, ref }) =>
        askFenced(
          { type: "click", tabId, ref },
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
