/**
 * Atlassian Document Format (ADF) <-> text conversion.
 *
 * JIRA Cloud's v3 REST API represents rich text (descriptions, comments) as ADF
 * — a JSON document tree — rather than a string. The Issues UI renders text with
 * the shared Markdown component, so `adfToMarkdown` flattens an ADF tree into
 * Markdown covering the node types that appear in normal tickets, degrading
 * gracefully (unknown block nodes recurse into their children; unknown leaves
 * drop out) rather than throwing on an unexpected shape.
 *
 * Writing back (edited descriptions, new comments) goes the other way:
 * `textToAdf` wraps plain text into a minimal ADF document. It does not attempt
 * to parse Markdown — it preserves the user's text verbatim as paragraphs so a
 * comment is never silently mangled, splitting on blank lines into paragraphs
 * and on single newlines into hard breaks.
 */

/** A minimal ADF document node. The real schema is far larger; we treat any
 *  node structurally (type + optional content/text/marks/attrs). */
export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
}

export interface AdfDoc {
  version: 1;
  type: "doc";
  content: AdfNode[];
}

/** Applies inline marks (bold/italic/code/strike/link) to a text run. */
function applyMarks(text: string, marks?: AdfNode["marks"]): string {
  if (!marks || marks.length === 0) return text;
  let out = text;
  for (const mark of marks) {
    switch (mark.type) {
      case "strong":
        out = `**${out}**`;
        break;
      case "em":
        out = `*${out}*`;
        break;
      case "code":
        out = `\`${out}\``;
        break;
      case "strike":
        out = `~~${out}~~`;
        break;
      case "link": {
        const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
        out = href ? `[${out}](${href})` : out;
        break;
      }
      // underline / subsup / textColor have no Markdown equivalent — leave the
      // text as-is rather than inventing syntax.
      default:
        break;
    }
  }
  return out;
}

/** Renders one inline (phrasing) node to a string. */
function inlineToMarkdown(node: AdfNode): string {
  switch (node.type) {
    case "text":
      return applyMarks(node.text ?? "", node.marks);
    case "hardBreak":
      return "\n";
    case "mention":
      return typeof node.attrs?.text === "string" ? node.attrs.text : "@mention";
    case "emoji":
      return typeof node.attrs?.text === "string"
        ? node.attrs.text
        : typeof node.attrs?.shortName === "string"
          ? (node.attrs.shortName as string)
          : "";
    case "inlineCard":
      return typeof node.attrs?.url === "string" ? (node.attrs.url as string) : "";
    case "date":
      return typeof node.attrs?.timestamp === "string" ? (node.attrs.timestamp as string) : "";
    default:
      // Unknown inline node: fall back to concatenating any child text.
      return (node.content ?? []).map(inlineToMarkdown).join("");
  }
}

function inlineChildren(node: AdfNode): string {
  return (node.content ?? []).map(inlineToMarkdown).join("");
}

/** Renders a list, prefixing each item. `ordered` switches "1." vs "-". */
function listToMarkdown(node: AdfNode, ordered: boolean): string {
  const items = node.content ?? [];
  return items
    .map((item, i) => {
      const marker = ordered ? `${i + 1}.` : "-";
      // A listItem holds block nodes; render them and indent continuation lines.
      const inner = (item.content ?? []).map(blockToMarkdown).join("\n\n").trim();
      const [first, ...rest] = inner.split("\n");
      const restIndented = rest.map((line) => (line ? `  ${line}` : line)).join("\n");
      return rest.length > 0 ? `${marker} ${first}\n${restIndented}` : `${marker} ${first}`;
    })
    .join("\n");
}

/** Renders one block node to Markdown. */
function blockToMarkdown(node: AdfNode): string {
  switch (node.type) {
    case "paragraph":
      return inlineChildren(node);
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      return `${"#".repeat(level)} ${inlineChildren(node)}`;
    }
    case "bulletList":
      return listToMarkdown(node, false);
    case "orderedList":
      return listToMarkdown(node, true);
    case "codeBlock": {
      const lang = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      const code = (node.content ?? []).map((n) => n.text ?? "").join("");
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }
    case "blockquote":
      return (node.content ?? [])
        .map(blockToMarkdown)
        .join("\n\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "rule":
      return "---";
    case "panel":
      // Panels (info/warning/note) have no Markdown equivalent — render their
      // contents as a blockquote so the text survives.
      return (node.content ?? [])
        .map(blockToMarkdown)
        .join("\n\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "mediaGroup":
    case "mediaSingle":
      // Attachments/embeds can't be inlined here; note their presence.
      return "_(attachment)_";
    case "table":
      return tableToMarkdown(node);
    default:
      // Unknown block: recurse so nested text isn't lost.
      return (node.content ?? []).map(blockToMarkdown).join("\n\n");
  }
}

/** Renders an ADF table to a GitHub-flavoured Markdown table (best effort). */
function tableToMarkdown(node: AdfNode): string {
  const rows = (node.content ?? []).filter((r) => r.type === "tableRow");
  if (rows.length === 0) return "";
  const cellText = (cell: AdfNode) =>
    (cell.content ?? [])
      .map(blockToMarkdown)
      .join(" ")
      .replace(/\n+/g, " ")
      // Escape backslashes before pipes so a literal "\" in the cell can't
      // combine with the pipe escaping (or a following char) and corrupt the
      // table markup.
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .trim();
  const toCells = (row: AdfNode) => (row.content ?? []).map(cellText);
  const header = toCells(rows[0]!);
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.slice(1).map((r) => `| ${toCells(r).join(" | ")} |`),
  ];
  return lines.join("\n");
}

/** Flattens an ADF document (or any subtree) into Markdown text. */
export function adfToMarkdown(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  const root = doc as AdfNode;
  const blocks = root.content ?? [];
  return blocks
    .map(blockToMarkdown)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Wraps plain text into a minimal ADF document. Blank lines separate paragraphs;
 * single newlines become hard breaks within a paragraph. Empty input yields an
 * empty document (valid ADF, e.g. to clear a description).
 */
export function textToAdf(text: string): AdfDoc {
  const trimmed = text.replace(/\r\n/g, "\n");
  if (trimmed.trim() === "") return { version: 1, type: "doc", content: [] };
  const paragraphs = trimmed.split(/\n{2,}/);
  const content: AdfNode[] = paragraphs.map((para) => {
    const lines = para.split("\n");
    const nodes: AdfNode[] = [];
    lines.forEach((line, i) => {
      if (i > 0) nodes.push({ type: "hardBreak" });
      if (line.length > 0) nodes.push({ type: "text", text: line });
    });
    return { type: "paragraph", content: nodes };
  });
  return { version: 1, type: "doc", content };
}
