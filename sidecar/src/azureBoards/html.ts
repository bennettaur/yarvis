/**
 * Azure Boards stores descriptions and comments as HTML, but the issue views
 * render Markdown (without raw HTML). These convert the small subset of HTML
 * the Azure editor produces, the way `jira/adf.ts` does for JIRA's ADF.
 * Anything unrecognised is reduced to its text, so nothing renders as markup.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith("#")) {
      const hex = code[1] === "x" || code[1] === "X";
      const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      // An out-of-range code point would make fromCodePoint throw, so a single
      // bad entity in a comment would break the whole work item.
      return point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/**
 * Real Azure HTML settles in one or two passes. The cap keeps a work item built
 * to nest thousands of levels deep from costing a pass per level.
 */
const MAX_PASSES = 10;

/**
 * Removes matches of `pattern` until the text stops changing, or `MAX_PASSES`
 * runs out. One pass is not enough: removing the inner tag of `<scr<b>ipt>`
 * leaves a new `<script>` behind.
 */
function removeUntilStable(text: string, pattern: RegExp): string {
  let previous: string;
  let current = text;
  let passes = 0;
  do {
    previous = current;
    current = current.replace(pattern, "");
    passes++;
  } while (current !== previous && passes < MAX_PASSES);
  return current;
}

// `[^<>]` rather than `[^>]` keeps each pass linear: a run of unclosed `<`
// would otherwise make every one of them rescan the rest of the text.
const TAG = /<[^<>]*>/g;

function stripTags(text: string): string {
  const stripped = removeUntilStable(text, TAG);
  // Still holding a tag means the cap ran out on deliberately nested input, so
  // drop every bracket rather than leave one behind.
  return /<[^<>]*>/.test(stripped) ? stripped.replace(/[<>]/g, "") : stripped;
}

/**
 * Marks where a `<pre>` block's text goes back in, after everything else ran.
 * A private-use character, so it can't clash with anything the editor writes.
 */
const SLOT = "\uE000";
const PRE_SLOT = new RegExp(`${SLOT}(\\d+)${SLOT}`, "g");

/**
 * Azure's editor output is far below this. Several patterns here rescan to the
 * end of the text for each unclosed tag, so an oversized body built to exploit
 * that is cut down before conversion.
 */
const MAX_HTML_LENGTH = 100_000;

/** Converts Azure's description/comment HTML to Markdown for display. */
export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return "";
  let out = html.length > MAX_HTML_LENGTH ? `${html.slice(0, MAX_HTML_LENGTH)}…` : html;
  out = out.replace(/\r\n?/g, "\n").replaceAll(SLOT, "");
  // Drop blocks whose contents are never meant to be read as text.
  out = removeUntilStable(out, /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi);
  // Code is set aside once decoded, so escaped markup in it (`&lt;b&gt;`)
  // isn't turned into formatting or stripped by the passes that follow.
  const codeBlocks: string[] = [];
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) => {
    const code = decodeEntities(stripTags(body.replace(/<br\s*\/?>/gi, "\n")));
    codeBlocks.push(`\n\n\`\`\`\n${code.trim()}\n\`\`\`\n\n`);
    return `${SLOT}${codeBlocks.length - 1}${SLOT}`;
  });
  out = out.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, text: string) => {
      const label = stripTags(text).trim();
      // Only web links keep their target; anything else (javascript:, data:)
      // is reduced to its label.
      return /^https?:\/\//i.test(href) ? `[${label || href}](${href})` : label;
    },
  );
  out = out.replace(/<img\b[^>]*src\s*=\s*["']([^"']*)["'][^>]*>/gi, (_m, src: string) =>
    /^https?:\/\//i.test(src) ? `![](${src})` : "",
  );
  out = out.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  out = out.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "_$2_");
  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  out = out.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, text: string) => {
    return `\n\n${"#".repeat(Number(level))} ${text.trim()}\n\n`;
  });
  out = out.replace(/<li\b[^>]*>/gi, "\n- ");
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<\/(p|div|ul|ol|table|tr|blockquote)>/gi, "\n\n");
  out = stripTags(out);
  // Entities decode last, so `&lt;b&gt;` the author typed stays visible text.
  // The Markdown renderer does not render raw HTML, so a decoded `<b>` can't
  // become a tag.
  out = decodeEntities(out);
  out = out.replace(PRE_SLOT, (_m, i: string) => codeBlocks[Number(i)] ?? "");
  return out
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
