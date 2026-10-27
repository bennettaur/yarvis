/**
 * Hover text built from the code under review, made safe to render.
 *
 * A language worker turns a JSDoc comment into hover markdown verbatim, and
 * Monaco renders a markdown image from any https URL, so a comment in a PR
 * could make the app fetch an address of the author's choosing the moment a
 * reviewer hovers a name. Every image in markdown starts with `![`, inline or
 * by reference, so escaping that pair is enough to keep any from forming.
 * This is done everywhere, code blocks included, rather than parsing the
 * markdown to find them: a parser that disagreed with Monaco's about where a
 * code block ends would let an image through. Raw HTML needs nothing here,
 * since Monaco drops it from markdown that doesn't opt in to HTML.
 *
 * Links stay; opening one goes through the link opener, which only hands
 * http(s) to the system browser.
 */
export function withoutImages(markdown: string): string {
  return markdown.split("![").join("!\\[");
}

interface MarkdownLike {
  value: string;
  isTrusted?: unknown;
  supportHtml?: boolean;
}

/** A hover's contents with images escaped and no trust or HTML granted. */
export function safeHoverContents<T extends MarkdownLike>(contents: readonly T[]): T[] {
  return contents.map((part) => ({
    ...part,
    value: withoutImages(part.value),
    isTrusted: false,
    supportHtml: false,
  }));
}

/**
 * Text shown as itself in a hover: every markdown character escaped, so a
 * model-written reason can't form a link, an image or formatting.
 */
export function plainHoverText(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&");
}
