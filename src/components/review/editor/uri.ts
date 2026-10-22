import type { ModelSide } from "./types";

export const REVIEW_SCHEME = "review";

/**
 * The identity of one file at one version of one PR,
 * `review://<refDomKey>/<side>/<path>`. Models are keyed by it, so the same
 * file opened in two tabs shares a model, and a definition provider can name a
 * file it has never seen opened.
 *
 * Each path segment is percent-encoded so a file name holding `#`, `?` or `%`
 * survives a round trip through Monaco's own URI parser.
 */
export function reviewUri(refDomKey: string, side: ModelSide, path: string): string {
  const encoded = path
    .split("/")
    .filter((segment) => segment !== "")
    .map(encodeURIComponent)
    .join("/");
  return `${REVIEW_SCHEME}://${refDomKey}/${side}/${encoded}`;
}

export interface ParsedReviewUri {
  refDomKey: string;
  side: ModelSide;
  path: string;
}

/** The parts of a {@link reviewUri}, or null for any other URI. */
export function parseReviewUri(uri: string): ParsedReviewUri | null {
  const match = /^review:\/\/([^/]+)\/(base|head)\/(.+)$/.exec(uri);
  if (!match) return null;
  try {
    const path = match[3].split("/").map(decodeURIComponent).join("/");
    return { refDomKey: match[1], side: match[2] as ModelSide, path };
  } catch {
    // A malformed escape is not one of ours.
    return null;
  }
}
