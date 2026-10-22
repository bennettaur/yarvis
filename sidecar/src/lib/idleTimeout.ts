import type { Server } from "bun";
import type { Context } from "hono";

/**
 * Lets one request stay open with nothing sent, past the server's `idleTimeout`
 * (`server.ts`), for a route that holds a connection until the user answers.
 * Bun passes its server to `fetch` as the second argument, which Hono exposes
 * as `c.env`. Under `app.request` in tests there is no server, so this does
 * nothing.
 */
export function disableIdleTimeout(c: Context): void {
  const server = c.env as Server<unknown> | undefined;
  server?.timeout?.(c.req.raw, 0);
}
