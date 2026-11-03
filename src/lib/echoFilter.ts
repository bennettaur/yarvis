/**
 * Spots a continuous-mode turn that is the assistant's own spoken reply coming
 * back through the microphone. Echo cancellation catches most of it, but not
 * all, and a leaked fragment sent as a user turn gets a spoken reply of its own,
 * which can leak again: the assistant ends up talking to itself.
 */

/** Share of a transcript's words that must appear in the reply to count as echo. */
const ECHO_WORD_SHARE = 0.8;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
}

/**
 * True when nearly every word of `transcript` is a word of `spokenReply`, the
 * text that was playing when the turn started. A user cutting in says
 * something of their own, so a short "yes" that also happens to be in the
 * reply is the cost of this check.
 */
export function looksLikeEcho(transcript: string, spokenReply: string): boolean {
  const heard = words(transcript);
  if (heard.length === 0) return false;
  const reply = new Set(words(spokenReply));
  const matched = heard.filter((word) => reply.has(word)).length;
  return matched / heard.length >= ECHO_WORD_SHARE;
}
