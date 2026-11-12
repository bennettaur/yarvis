/** Header carrying the PTY id, from the session's `YARVIS_SESSION_KEY`. */
export const SESSION_KEY_HEADER = "X-Yarvis-Session-Key";

/** Header carrying the PTY's `YARVIS_SESSION_TOKEN`; see `sessionTokenMatches`. */
export const SESSION_TOKEN_HEADER = "X-Yarvis-Session-Token";

/** Header carrying `YARVIS_AGENT_HARNESS_TOKEN`; see `harnessTokenMatches`. */
export const HARNESS_TOKEN_HEADER = "X-Yarvis-Harness-Token";
