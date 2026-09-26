import { tool } from "ai";
import { z } from "zod";
import { fence, newNonce, untrustedWarning } from "../lib/fencing.ts";
import { type BrowserBridge, browserBridge, type CommandResult } from "./bridge.ts";

/**
 * Read-only browser tools for the chat model, answered by the Yarvis Chrome
 * extension in whatever profile it is installed in. There is deliberately no
 * click, type or navigate tool: this is for reading a page the user already has
 * open (Slack, a ticket, a doc), and anything that acts through their logged-in
 * sessions would need its own approval story.
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

/** What a tool says when the browser side failed; the model can relay it. */
function failure(result: CommandResult): { error: string } {
  return { error: result.error ?? "The browser returned an error." };
}

async function ask(bridge: BrowserBridge, command: Parameters<BrowserBridge["request"]>[0]) {
  try {
    return await bridge.request(command);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function buildBrowserTools(bridge: BrowserBridge = browserBridge) {
  return {
    list_browser_tabs: tool({
      description:
        "List the tabs open in the user's Chrome (id, window, title, URL, and which one is active). Use it to find the tab to read, e.g. the Slack tab.",
      inputSchema: z.object({}),
      execute: async () => {
        const result = await ask(bridge, { type: "list_tabs" });
        if (!result.ok) return failure(result);
        const tabs = z.array(tabSchema).safeParse(result.data);
        if (!tabs.success) return { error: "The browser sent back tabs in an unexpected shape." };
        // Titles and URLs are written by whoever runs each site.
        const nonce = newNonce();
        return {
          notice: untrustedWarning(nonce, "browser-tabs"),
          tabs: fence(
            JSON.stringify(tabs.data.map((tab) => ({ ...tab, url: withoutQuery(tab.url) }))),
            nonce,
            "browser-tabs",
          ),
        };
      },
    }),
    read_browser_page: tool({
      description:
        "Read the visible text of a page open in the user's Chrome — the active tab by default, or a tab id from list_browser_tabs. Returns the URL, title, any text the user has selected, and the page text. Read-only: it cannot click, type or navigate.",
      inputSchema: z.object({
        tabId: z.number().int().optional().describe("Tab id from list_browser_tabs"),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(MAX_PAGE_CHARS)
          .default(DEFAULT_PAGE_CHARS)
          .describe("Cap on the page text returned"),
      }),
      execute: async ({ tabId, maxChars }) => {
        const result = await ask(bridge, { type: "read_page", tabId, maxChars });
        if (!result.ok) return failure(result);
        const page = pageSchema.safeParse(result.data);
        if (!page.success) return { error: "The browser sent back a page in an unexpected shape." };

        // Page text is third-party content — a Slack message or a web page can
        // address whoever reads it — so it is fenced and the model is told so.
        // The extension already caps the text; this is the sidecar's own bound.
        const nonce = newNonce();
        const { url, title, selection, text, truncated } = page.data;
        const body = text.slice(0, maxChars);
        return {
          notice: untrustedWarning(nonce, "browser-page"),
          page: fence(
            JSON.stringify({
              url,
              title,
              ...(selection ? { selection: selection.slice(0, maxChars) } : {}),
              text: body,
              truncated: Boolean(truncated) || text.length > maxChars,
            }),
            nonce,
            "browser-page",
          ),
        };
      },
    }),
  };
}
