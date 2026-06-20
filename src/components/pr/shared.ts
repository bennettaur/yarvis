import { refDomKey } from "../../lib/pr/ref";
import type { PrRef } from "../../lib/pr/types";

export type { PrRef } from "../../lib/pr/types";

/**
 * Stable DOM id for one file's diff, so a `PrFileList` item can scroll to the
 * matching `PrFileDiffs` entry — even when the two are separate components in
 * an Omni layout. The ref key keeps ids unique when several PRs share a page.
 */
export function prFileAnchorId(ref: PrRef, index: number): string {
  return `prfile-${refDomKey(ref)}-${index}`;
}
