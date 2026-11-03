/**
 * Spots a continuous-mode turn that is the assistant's own spoken reply coming
 * back through the microphone. Echo cancellation catches most of it, but not
 * all, and a leaked fragment sent as a user turn gets a spoken reply of its own,
 * which can leak again: the assistant ends up talking to itself.
 */

/**
 * Share of a transcript's word pairs that must appear, in order, in the reply.
 * Below 1 because speech-to-text mishears a word now and then, and each
 * misheard word breaks the two pairs around it.
 */
const ECHO_PAIR_SHARE = 0.6;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
}

/** Adjacent word pairs: "a b c" gives "a b" and "b c". */
function pairs(list: string[]): string[] {
  return list.slice(1).map((word, i) => `${list[i]} ${word}`);
}

/**
 * True when `transcript` reads as a run of `spokenReply`, the reply text queued
 * for speech when the turn started. Pairs rather than single words, so the
 * user's own words said over a long reply aren't dropped just because each
 * word appears in it somewhere. A one-word turn that is also a word of the
 * reply, such as "yes", is still dropped.
 */
export function looksLikeEcho(transcript: string, spokenReply: string): boolean {
  const heardWords = words(transcript);
  if (heardWords.length === 0) return false;
  const replyWords = words(spokenReply);
  if (heardWords.length === 1) return replyWords.includes(heardWords[0]!);
  const heard = pairs(heardWords);
  const reply = new Set(pairs(replyWords));
  const matched = heard.filter((pair) => reply.has(pair)).length;
  return matched / heard.length >= ECHO_PAIR_SHARE;
}
