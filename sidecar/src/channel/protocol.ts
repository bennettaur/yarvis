/**
 * What the relay and the sidecar's `/ingest/channel` routes agree on. Kept free
 * of imports so the relay, which runs once per session, doesn't load the
 * server's modules to get a few strings.
 */

/** The argument that makes the sidecar's entry point run the relay instead of the server. */
export const CHANNEL_RELAY_ARG = "channel-relay";

export const RELAY_ID_HEADER = "X-Yarvis-Relay-Id";
export const RELAY_PID_HEADER = "X-Yarvis-Relay-Pid";
