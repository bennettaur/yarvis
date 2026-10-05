import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dirname, "..");
export const OUTPUT_DIR = join(REPO_ROOT, "demo", "output");

/** Lowercases `text` and joins its words with hyphens, for use in a file name. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Where one flow's screenshots and video go, named after the flow's title. */
export function flowOutputDir(title: string): string {
  const slug = slugify(title);
  // An empty slug would resolve to OUTPUT_DIR itself, which the fixture clears.
  if (!slug) throw new Error(`flow title "${title}" needs at least one letter or digit`);
  return join(OUTPUT_DIR, slug);
}
