/**
 * The sidecar's entry point. The same executable also runs as a workspace
 * session's channel relay, because a packaged build ships one compiled binary
 * and Claude Code needs a program to start for it.
 */
import { CHANNEL_RELAY_ARG } from "./channel/protocol.ts";

// Both are imported only once chosen, so the relay never loads the server's modules.
if (process.argv.slice(2).includes(CHANNEL_RELAY_ARG)) {
  const { runChannelRelay } = await import("./channel/relay.ts");
  await runChannelRelay();
} else {
  await import("./server.ts");
}
