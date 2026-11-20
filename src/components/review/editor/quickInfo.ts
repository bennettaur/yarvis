import { safeHoverContents } from "./hoverSafety";

/** The parts of TypeScript's `QuickInfo` a hover is built from. */
interface DisplayPart {
  text: string;
}
interface JSDocTag {
  name: string;
  text?: DisplayPart[] | string;
}
export interface QuickInfo {
  textSpan: { start: number; length: number };
  displayParts?: DisplayPart[];
  documentation?: DisplayPart[];
  tags?: JSDocTag[];
}

const partsToString = (parts: DisplayPart[] | undefined) =>
  (parts ?? []).map((part) => part.text).join("");

/** A JSDoc tag as Monaco's own TypeScript hover writes it. */
function tagToString(tag: JSDocTag): string {
  let label = `*@${tag.name}*`;
  if (tag.name === "param" && Array.isArray(tag.text) && tag.text.length > 0) {
    const [name, ...rest] = tag.text;
    label += `\`${name.text}\``;
    if (rest.length > 0) label += ` — ${rest.map((part) => part.text).join(" ")}`;
  } else if (Array.isArray(tag.text)) {
    label += ` — ${tag.text.map((part) => part.text).join(" ")}`;
  } else if (tag.text) {
    label += ` — ${tag.text}`;
  }
  return label;
}

type HoverPart = { value: string; isTrusted?: boolean; supportHtml?: boolean };

/**
 * The hover for a TypeScript quick-info answer: the signature as a code block,
 * then the JSDoc and its tags. The JSDoc is the PR author's text, so it goes
 * through {@link safeHoverContents} like every hover the review editor shows.
 */
export function quickInfoHover(info: QuickInfo): HoverPart[] {
  const signature = partsToString(info.displayParts);
  const documentation = partsToString(info.documentation);
  const tags = (info.tags ?? []).map(tagToString).join("  \n\n");
  const parts: HoverPart[] = [{ value: `\`\`\`typescript\n${signature}\n\`\`\`\n` }];
  const prose = [documentation, tags].filter((text) => text !== "").join("\n\n");
  if (prose) parts.push({ value: prose });
  return safeHoverContents(parts);
}
