import { Hono } from "hono";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { OAUTH_CALLBACK_PATH } from "./oauth.ts";
import { completeAuthorization } from "./service.ts";

/**
 * The loopback redirect an MCP authorization server sends the user back to,
 * mounted at the app root because a browser redirect can't carry the sidecar's
 * bearer token. Its protection is the single-use `state` nonce: the flow it
 * names was started by this process, and an unknown or reused value is refused.
 */
export function createMcpOAuthCallbackRoutes(config: Config): Hono {
  const router = new Hono();

  router.get(OAUTH_CALLBACK_PATH, async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const err = c.req.query("error");
    if (err) {
      const description = c.req.query("error_description");
      return c.html(donePage(`Authorization failed: ${description ?? err}`), 400);
    }
    if (!code || !state) {
      return c.html(donePage("Invalid authorization response."), 400);
    }
    if (!config.databaseUrl) {
      return c.html(donePage("Yarvis has no database configured."), 503);
    }
    try {
      const { serverName } = await completeAuthorization(
        config,
        getDb(config.databaseUrl).db,
        code,
        state,
      );
      return c.html(donePage(`${serverName} connected. You can close this tab.`));
    } catch (e) {
      return c.html(donePage(e instanceof Error ? e.message : String(e)), 400);
    }
  });

  return router;
}

/** Escapes text for safe interpolation into the callback HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function donePage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Yarvis</title></head><body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>${escapeHtml(message)}</p></body></html>`;
}
