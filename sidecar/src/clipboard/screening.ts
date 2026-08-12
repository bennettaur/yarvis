/**
 * Credential screening for the clipboard book.
 *
 * The clipboard book is a convenience store for things the user copies often —
 * an identity id, a CLI incantation, a link — and explicitly *not* a secret
 * store (secrets belong in the Keychain). Two paths lean on this module: saving
 * an entry refuses text that looks like a credential, and clipboard history is
 * screened before it is shown so a password that passed through the clipboard
 * isn't put back on screen in a searchable list.
 *
 * It is a heuristic, so it is tuned to be loud about the shapes that are
 * unmistakably credentials (provider token prefixes, PEM blocks, JWTs, URLs
 * with an embedded password) and about high-entropy tokens that no human typed.
 * Identifiers the feature exists to hold — UUIDs, hex digests, plain URLs — are
 * deliberately left alone: a false positive blocks a legitimate entry, which is
 * the failure mode that makes the feature useless.
 */

export interface SecretFinding {
  /** Stable identifier for the pattern that matched, e.g. "github-token". */
  kind: string;
  /** One line, safe to show the user verbatim — never echoes the match. */
  reason: string;
}

interface SecretRule {
  kind: string;
  reason: string;
  pattern: RegExp;
}

/**
 * Ordered most-specific first, so the reported `kind` names the actual provider
 * rather than the generic assignment/entropy fallbacks below it.
 */
const RULES: SecretRule[] = [
  {
    kind: "private-key",
    reason: "contains a PEM private key block",
    pattern: /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/,
  },
  {
    kind: "aws-access-key-id",
    reason: "looks like an AWS access key id",
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[0-9A-Z]{16}\b/,
  },
  {
    kind: "github-token",
    reason: "looks like a GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  {
    kind: "slack-token",
    reason: "looks like a Slack token",
    pattern: /\bxox[abeprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    kind: "google-api-key",
    reason: "looks like a Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    kind: "stripe-key",
    reason: "looks like a Stripe key",
    pattern: /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  },
  {
    kind: "npm-token",
    reason: "looks like an npm token",
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/,
  },
  {
    // Covers OpenAI (sk-, sk-proj-), Anthropic (sk-ant-), and OpenRouter (sk-or-).
    kind: "api-key",
    reason: "looks like a provider API key",
    pattern: /\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{16,}\b/,
  },
  {
    kind: "jwt",
    reason: "looks like a JWT — those carry a signed session",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  {
    kind: "credential-url",
    reason: "is a URL with an embedded password",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@/i,
  },
  {
    kind: "auth-header",
    // A variable reference (`$TOKEN`, `${TOKEN}`, `<token>`) is a template, not
    // the secret itself, so those stay saveable — a curl recipe is exactly the
    // kind of thing this feature is for.
    reason: "contains an authorization header value",
    // The scheme word is optional and skipped over: `Authorization: Bearer <hex>`
    // otherwise reads as a six-character value and slips through, which is the
    // exact shape the Settings screen offers for copying (the MCP endpoint's
    // token, and a `claude mcp add` command carrying it).
    pattern:
      /\b(?:authorization|x-api-key|proxy-authorization)\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?(?![$<{"']?\$)[^\s"']{8,}/i,
  },
  {
    kind: "credential-assignment",
    reason: "assigns a password or key inline",
    pattern:
      /\b(?:pass(?:word|wd)?|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|credentials?)\s*[:=]\s*(?![$<{]|["']?\$)["']?[^\s"']{6,}/i,
  },
];

/** Shannon entropy in bits per character. */
function entropyBitsPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Minimum length for the entropy fallback to consider a token at all. */
const ENTROPY_MIN_LENGTH = 32;
const ENTROPY_MIN_BITS = 4;

/**
 * True for a token that has the shape of a machine-generated secret: long,
 * mixed-case with digits, and high entropy. Requiring all three character
 * classes is what keeps UUIDs and hex digests — the ids this feature exists to
 * store — out of the net, since neither has uppercase and digits alongside
 * lowercase.
 */
function looksHighEntropy(token: string): boolean {
  if (token.length < ENTROPY_MIN_LENGTH) return false;
  if (token.includes("://")) return false;
  if (!/[a-z]/.test(token)) return false;
  if (!/[A-Z]/.test(token)) return false;
  if (!/\d/.test(token)) return false;
  // Anything outside the base64url/base62 alphabet reads as prose or a path,
  // not a token.
  if (!/^[A-Za-z0-9_\-+/=.]+$/.test(token)) return false;
  return entropyBitsPerChar(token) >= ENTROPY_MIN_BITS;
}

/**
 * Screens text for credentials. Returns the first finding, or null when the
 * text is safe to store and display.
 */
export function detectSecret(text: string): SecretFinding | null {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return { kind: rule.kind, reason: rule.reason };
  }
  for (const token of text.split(/[\s"'`,;()<>[\]{}]+/)) {
    if (looksHighEntropy(token)) {
      return {
        kind: "high-entropy-token",
        reason: "contains a long random-looking token",
      };
    }
  }
  return null;
}
