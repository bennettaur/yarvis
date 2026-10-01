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

/** Converts Azure's description/comment HTML to Markdown for display. */
export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return "";
  let out = html.replace(/\r\n?/g, "\n");
  // Drop blocks whose contents are never meant to be read as text.
  out = out.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) => {
    const code = decodeEntities(body.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
    return `\n\n\`\`\`\n${code.trim()}\n\`\`\`\n\n`;
  });
  out = out.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, text: string) => {
      const label = text.replace(/<[^>]+>/g, "").trim();
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
  out = out.replace(/<[^>]+>/g, "");
  out = decodeEntities(out);
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
