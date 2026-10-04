/**
 * Azure Boards stores descriptions and comments as HTML, but the issue views
 * render Markdown (without raw HTML). These convert the small subset of HTML
 * the Azure editor produces, the way `jira/adf.ts` does for JIRA's ADF.
 * Anything unrecognised is reduced to its text.
 *
 * The HTML is untrusted: anyone who can edit a work item writes it. htmlparser2's
 * tokenizer stays linear on any input, including crafted unclosed tags, and
 * decodes entities exactly once. Decoded text can still spell out `<img ...>` or
 * Markdown of its own, so the output is untrusted Markdown: it is safe to show
 * only because the renderer doesn't render raw HTML and filters link schemes.
 */

import { Parser } from "htmlparser2";

/** Elements whose content is never meant to be read as text. */
const SKIPPED = new Set(["script", "style", "noscript", "template", "head"]);

/** Elements that end a paragraph-like block. */
const BLOCKS = new Set(["p", "div", "ul", "ol", "table", "tr", "blockquote"]);

/** The Markdown that wraps each inline emphasis element. */
const INLINE_MARKS: Record<string, string> = {
  strong: "**",
  b: "**",
  em: "_",
  i: "_",
};

const isHeading = (name: string) => /^h[1-6]$/.test(name);

/**
 * The URL to link to, or null for anything but http(s) (javascript:, data:).
 * Brackets are percent-encoded so the URL can't close the Markdown `(...)` it
 * sits in and start a second link.
 */
function toWebUrl(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href.replace(/[()<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A fenced code block whose fence is longer than any backtick run inside it. */
function fence(code: string): string {
  const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const marks = "`".repeat(Math.max(3, longestRun + 1));
  return `\n\n${marks}\n${code}\n${marks}\n\n`;
}

/** Converts Azure's description/comment HTML to Markdown for display. */
export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return "";

  const doc: string[] = [];
  // The open `<a>` collects its label separately so it can be wrapped once the
  // tag closes. htmlparser2 closes an open `<a>` when another opens, and closes
  // everything still open at the end, so there is at most one at a time.
  let openLink: { href: string | null; label: string[] } | null = null;
  const write = (text: string) => (openLink?.label ?? doc).push(text);

  let skipDepth = 0;
  let preDepth = 0;
  let preText: string[] = [];

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (SKIPPED.has(name)) {
          skipDepth++;
          return;
        }
        if (skipDepth > 0) return;
        if (preDepth > 0) {
          if (name === "pre") preDepth++;
          else if (name === "br") preText.push("\n");
          return;
        }
        if (name === "pre") {
          preDepth = 1;
          preText = [];
        } else if (name === "a") {
          openLink = { href: toWebUrl(attribs.href), label: [] };
        } else if (name === "img") {
          const src = toWebUrl(attribs.src);
          if (src) write(`![](${src})`);
        } else if (name === "br") {
          write("\n");
        } else if (name === "li") {
          write("\n- ");
        } else if (isHeading(name)) {
          write(`\n\n${"#".repeat(Number(name[1]))} `);
        } else if (name === "code") {
          write("`");
        } else if (INLINE_MARKS[name]) {
          write(INLINE_MARKS[name]);
        }
      },
      ontext(text) {
        if (skipDepth > 0) return;
        if (preDepth > 0) preText.push(text);
        // The Azure editor pads with `&nbsp;`; plain spaces trim and wrap normally.
        else write(text.replace(/\u00a0/g, " "));
      },
      onclosetag(name) {
        if (SKIPPED.has(name)) {
          skipDepth--;
          return;
        }
        if (skipDepth > 0) return;
        if (preDepth > 0) {
          if (name === "pre" && --preDepth === 0) write(fence(preText.join("").trim()));
          return;
        }
        if (name === "a" && openLink) {
          const { href, label: parts } = openLink;
          openLink = null;
          // Escaped so a `]` in the text can't end the label early. Backslashes
          // too, or `\]` would escape the escape and let the `]` through.
          const label = parts
            .join("")
            .trim()
            .replace(/[\\[\]]/g, "\\$&");
          write(href ? `[${label || href}](${href})` : label);
        } else if (isHeading(name)) {
          write("\n\n");
        } else if (name === "code") {
          write("`");
        } else if (INLINE_MARKS[name]) {
          write(INLINE_MARKS[name]);
        } else if (BLOCKS.has(name)) {
          write("\n\n");
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html.replace(/\r\n?/g, "\n"));
  parser.end();

  return doc
    .join("")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Converts plain text the user typed into HTML for Azure: escaped, one `<div>`
 * per line, which is what the Azure editor itself writes. Blank lines become
 * `<div><br></div>` so they survive.
 */
export function textToHtml(text: string): string {
  if (!text) return "";
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line.trim() ? `<div>${escapeHtml(line)}</div>` : "<div><br></div>"))
    .join("");
}
