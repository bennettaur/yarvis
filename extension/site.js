// The rule that keeps Yarvis on the site the user is looking at.

/**
 * A "site" is an origin: scheme, host and port. Slack, for one, keeps navigating
 * inside app.slack.com, and treating a sibling subdomain as the same site would
 * need a public-suffix list to do safely.
 */
export function sameOrigin(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return (x.protocol === "http:" || x.protocol === "https:") && x.origin === y.origin;
  } catch {
    return false;
  }
}

/**
 * Labels of controls that change or send something rather than move around. A
 * click here is refused whatever the model asks for, because Yarvis is meant to
 * read a signed-in site and a planted instruction should not be able to post,
 * delete or leave anything. It is a heuristic on the visible label, not a
 * guarantee, which is why the tools also ask for approval on a spoken turn.
 */
export const BLOCKED_LABEL_SOURCE =
  "\\b(delete|remove|leave|archive|deactivate|sign ?out|log ?out|send|post|reply|submit|publish|pay|purchase|buy|confirm|unsubscribe|block|report|mute|kick|invite|save|edit|share|react|upload)\\b";

export function isBlockedLabel(label) {
  return new RegExp(BLOCKED_LABEL_SOURCE, "i").test(label);
}
