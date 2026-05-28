/** Identifies a single pull request; the prop shape every PR component takes. */
export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Stable DOM id for one file's diff, so a `PrFileList` item can scroll to the
 * matching `PrFileDiffs` entry — even when the two are separate components in
 * an Omni layout. The PR trio keeps ids unique when several PRs share a page.
 */
export function prFileAnchorId(ref: PrRef, index: number): string {
  return `prfile-${ref.owner}-${ref.repo}-${ref.number}-${index}`;
}
