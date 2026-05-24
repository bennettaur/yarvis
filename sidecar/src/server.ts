import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const app = createApp(config);

const server = Bun.serve({
  port: config.port,
  hostname: "127.0.0.1",
  fetch: app.fetch,
});

console.log(`[sidecar] listening on http://127.0.0.1:${server.port}`);
if (config.tokenGenerated) {
  // Only happens when run standalone (no host-supplied token); surfaced so a
  // local client can authenticate during development/testing.
  console.log(`[sidecar] generated dev token: ${config.token}`);
}
