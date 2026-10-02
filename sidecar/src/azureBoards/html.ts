/**
 * Azure Boards stores descriptions and comments as HTML, but the issue views
 * render Markdown (without raw HTML). These convert the small subset of HTML
 * the Azure editor produces, the way `jira/adf.ts` does for JIRA's ADF.
 * Anything unrecognised is reduced to its text, so nothing renders as markup.
 *
 * The HTML is untrusted: anyone who can edit a work item writes it. It goes
 * through htmlparser2's tokenizer, which runs in linear time, rather than
 * through regexes, which crafted unclosed tags can make take minutes.
 */

import { Parser } from "htmlparser2";

/** Elements whose content is never meant to be read as text. */
const SKIPPED = new Set(["script", "style", "noscript", "template", "head"]);

/** Elements that end a paragraph-like block. */
const BLOCKS = new Set(["p", "div", "ul", "ol", "table", "tr", "blockquote"]);

const INLINE_MARKS: Record<string, string> = {
  strong: "**",
  b: "**",
  em: "_",
  i: "_",
};

/** Only web links keep their target; anything else (javascript:, data:) is dropped. */
function webUrl(value: string | undefined): string | null {
  return value && /^https?:\/\//i.test(value.trim()) ? value.trim() : null;
}

/** Converts Azure's description/comment HTML to Markdown for display. */
export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return "";

  // Each open `<a>` collects its label in a buffer of its own, so the label can
  // be wrapped once the tag closes. The bottom buffer is the document.
  const buffers: string[][] = [[]];
  const links: (string | null)[] = [];
  const write = (text: string) => buffers[buffers.length - 1]?.push(text);

  let skipDepth = 0;
  let preDepth = 0;
  let codeText: string[] = [];

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
          else if (name === "br") codeText.push("\n");
          return;
        }
        if (name === "pre") {
          preDepth = 1;
          codeText = [];
        } else if (name === "a") {
          links.push(webUrl(attribs.href));
          buffers.push([]);
        } else if (name === "img") {
          const src = webUrl(attribs.src);
          if (src) write(`![](${src})`);
        } else if (name === "br") {
          write("\n");
        } else if (name === "li") {
          write("\n- ");
        } else if (/^h[1-6]$/.test(name)) {
          write(`\n\n${"#".repeat(Number(name[1]))} `);
        } else if (name === "code") {
          write("`");
        } else if (INLINE_MARKS[name]) {
          write(INLINE_MARKS[name]);
        }
      },
      ontext(text) {
        if (skipDepth > 0) return;
        if (preDepth > 0) codeText.push(text);
        // The Azure editor pads with `&nbsp;`; plain spaces trim and wrap normally.
        else write(text.replace(/\u00a0/g, " "));
      },
      onclosetag(name) {
        if (SKIPPED.has(name)) {
          skipDepth = Math.max(0, skipDepth - 1);
          return;
        }
        if (skipDepth > 0) return;
        if (preDepth > 0) {
          if (name === "pre" && --preDepth === 0) {
            write(`\n\n\`\`\`\n${codeText.join("").trim()}\n\`\`\`\n\n`);
          }
          return;
        }
        if (name === "a" && buffers.length > 1) {
          const label = (buffers.pop() ?? []).join("").trim();
          const href = links.pop();
          write(href ? `[${label || href}](${href})` : label);
        } else if (/^h[1-6]$/.test(name)) {
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

  // Fold any links left open at the end into the document as plain labels.
  while (buffers.length > 1) {
    const label = (buffers.pop() ?? []).join("");
    links.pop();
    write(label);
  }

  return (buffers[0] ?? [])
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
