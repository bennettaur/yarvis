/**
 * The sidecar's entry point. The same executable also runs as a workspace
 * session's channel relay, because a packaged build ships one compiled binary
 * and Claude Code needs a program to start for it.
 */
import { CHANNEL_RELAY_ARG, runChannelRelay } from "./channel/relay.ts";

if (process.argv.slice(2).includes(CHANNEL_RELAY_ARG)) {
  await runChannelRelay();
} else {
  await import("./server.ts");
}
