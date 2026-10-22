import type { ModelSide } from "./types";

export const REVIEW_SCHEME = "review";

/**
 * The URI authority for a PR: its `refKey` as hex. A readable form won't do.
 * `refDomKey` folds `/` and `:` together, so two PRs could share an authority
 * and with it a model, and Monaco lowercases an authority and reads a colon in
 * it as a port when it prints a URI. Hex survives all three.
 */
function encodeAuthority(refKey: string): string {
  return Array.from(new TextEncoder().encode(refKey), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function decodeAuthority(authority: string): string | null {
  if (authority.length === 0 || authority.length % 2 !== 0 || /[^0-9a-f]/.test(authority)) {
    return null;
  }
  const bytes = new Uint8Array(authority.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(authority.slice(i * 2, i * 2 + 2), 16);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The identity of one file at one version of one PR,
 * `review://<hex refKey>/<side>/<path>`. Models are keyed by it, so the same
 * file opened in two tabs shares a model, and a definition provider can name a
 * file it has never seen opened.
 *
 * Each path segment is percent-encoded so a file name holding `#`, `?` or `%`
 * survives a round trip through Monaco's own URI parser.
 */
export function reviewUri(refKey: string, side: ModelSide, path: string): string {
  const encoded = path
    .split("/")
    .filter((segment) => segment !== "")
    .map(encodeURIComponent)
    .join("/");
  return `${REVIEW_SCHEME}://${encodeAuthority(refKey)}/${side}/${encoded}`;
}

export interface ParsedReviewUri {
  refKey: string;
  side: ModelSide;
  path: string;
}

/** The parts of a {@link reviewUri}, or null for any other URI. */
export function parseReviewUri(uri: string): ParsedReviewUri | null {
  const match = /^review:\/\/([^/]+)\/(base|head)\/(.+)$/.exec(uri);
  if (!match) return null;
  const refKey = decodeAuthority(match[1]);
  if (refKey === null) return null;
  try {
    const path = match[3].split("/").map(decodeURIComponent).join("/");
    return { refKey, side: match[2] as ModelSide, path };
  } catch {
    // A malformed escape is not one of ours.
    return null;
  }
}

/**
 * {@link reviewUri} from a URI's already-decoded parts, as Monaco's `Uri`
 * holds them. Null when the authority is not one {@link reviewUri} wrote.
 */
export function reviewUriFromParts(authority: string, path: string): string | null {
  const refKey = decodeAuthority(authority);
  const [, side, ...rest] = path.split("/");
  if (refKey === null || (side !== "base" && side !== "head")) return null;
  return reviewUri(refKey, side, rest.join("/"));
}
