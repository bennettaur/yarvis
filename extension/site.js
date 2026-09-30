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
  "\\b(?:delete|remove|leave|archive|deactivate|sign ?out|log ?out|send|post|reply|submit|publish|pay|purchase|buy|confirm|unsubscribe|block|report|mute|kick|invite|save|edit|share|react|upload|approve|accept|decline|join|add|create|resolve|discard|trash|dismiss|revoke|disable|authorize|install|snooze|forward|apply|continue)(?:s|es|d|ed|ing)?\\b";

/**
 * The same screen for a link's address. A same-site GET such as /logout or
 * /channels/leave changes state without leaving the site, and a link's label is
 * not where that shows.
 */
export const BLOCKED_PATH_SOURCE =
  "(log-?out|sign-?out|delete|remove|leave|unsubscribe|deactivate|invite)";

export function isBlockedPath(path) {
  return new RegExp(BLOCKED_PATH_SOURCE, "i").test(path);
}

export function isBlockedLabel(label) {
  return new RegExp(BLOCKED_LABEL_SOURCE, "i").test(label);
}
