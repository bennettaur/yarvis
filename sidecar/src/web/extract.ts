/**
 * Turns a fetched page into the text a person visiting it would read.
 *
 * The page is untrusted, and the main risk is text written for the model rather
 * than for people: an instruction in a `display:none` block, white-on-white, an
 * `aria-hidden` span, or spelled in invisible Unicode tag characters. So the
 * extraction drops what a browser wouldn't show, strips characters that render
 * as nothing, and reports how much of each it removed, since a page that hides
 * text is itself worth telling the user about.
 *
 * Only inline signals can be seen here. A class hidden by a stylesheet, text
 * colored to match its background, or content positioned off screen by external
 * CSS still comes through, which is why the result is also fenced as data and
 * screened for instruction-like phrasing.
 */

import { Parser } from "htmlparser2";

/** Elements whose content is never page text. */
const NON_TEXT = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "head",
  "svg",
  "math",
  "iframe",
  "object",
  "embed",
  "canvas",
  "audio",
  "video",
  "select",
]);

const BLOCKS = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "nav",
  "aside",
  "ul",
  "ol",
  "table",
  "tr",
  "blockquote",
  "figure",
  "figcaption",
  "form",
  "dl",
  "dt",
  "dd",
]);

/** Class names the common CSS frameworks use to hide an element. */
const HIDING_CLASSES = new Set([
  "hidden",
  "d-none",
  "invisible",
  "sr-only",
  "visually-hidden",
  "visuallyhidden",
  "screen-reader-text",
]);

/**
 * Classes that show an element again at a breakpoint: Tailwind's `md:block`,
 * Bootstrap's `d-md-block`. `hidden md:block` is desktop content, not hidden.
 */
const RESPONSIVE_DISPLAY =
  /^(?:[a-z0-9-]+:)+(?:block|flex|grid|inline|inline-block|inline-flex|table|contents)$|^d-(?:sm|md|lg|xl|xxl)-(?!none)/;

/** Inline style declarations that keep text off screen, matched with whitespace and comments removed. */
const HIDING_STYLES = [
  /(?:^|;)display:none/,
  /(?:^|;)visibility:(?:hidden|collapse)/,
  /(?:^|;)content-visibility:hidden/,
  /(?:^|;)opacity:(?:0+(?:\.0*)?|\.0+)(?:;|$|!)/,
  /(?:^|;)font-size:(?:0+(?:\.0+)?(?:px|em|rem|pt|%)?|0?\.\d+px|1px)(?:;|$|!)/,
  /(?:^|;)color:transparent/,
  /(?:^|;)(?:text-indent|left|right|top|margin-left|margin-top):-\d{3,}/,
  /(?:^|;)transform:scale\(0(?:\.0+)?[,)]/,
  /(?:^|;)clip:rect\(0/,
  /(?:^|;)clip-path:inset\((?:50|100)%/,
];

/** A box of a pixel or less hides its text only when its overflow is clipped too. */
const TINY_BOX = /(?:^|;)(?:max-)?(?:height|width):(?:0+(?:px)?|1px)(?:;|$|!)/;
const CLIPPED = /(?:^|;)overflow:hidden/;

/**
 * Characters that render as nothing, or reorder what is shown: zero-width
 * spaces and joiners, bidi overrides, the soft hyphen, the invisible math
 * operators, Unicode tag characters (which can spell out a whole hidden
 * sentence), variation-selector supplements, and C0/C1 control characters
 * other than tab and newline.
 */
const INVISIBLE_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00AD\\u180E\\u200B-\\u200F\\u202A-\\u202E" +
    "\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}]",
  "gu",
);

/** How much hidden text is kept for screening. It is never returned. */
const MAX_HIDDEN_CHARS = 20_000;

export interface StrippedText {
  text: string;
  /** How many invisible characters were removed. */
  removed: number;
}

export function stripInvisible(text: string): StrippedText {
  let removed = 0;
  const clean = text.replace(INVISIBLE_CHARS, () => {
    removed++;
    return "";
  });
  return { text: clean, removed };
}

export interface ExtractedPage {
  title: string;
  /** The visible text, as light Markdown: headings, list items, links. */
  text: string;
  /** Hidden elements that held text, each counted once at its outermost hidden element. */
  hiddenBlocks: number;
  /** The text those hidden elements held, kept only so it can be screened. */
  hiddenText: string;
}

/**
 * Removes `/* … *\/` comments, which a browser ignores but which would split
 * `display:/**\/none` past the style patterns. A loop rather than a lazy regex,
 * which backtracks quadratically on a run of unclosed comments.
 */
function stripCssComments(style: string): string {
  let out = "";
  let i = 0;
  while (i < style.length) {
    const open = style.indexOf("/*", i);
    if (open === -1) return out + style.slice(i);
    out += style.slice(i, open);
    const close = style.indexOf("*/", open + 2);
    if (close === -1) return out;
    i = close + 2;
  }
  return out;
}

function isHiddenElement(name: string, attribs: Record<string, string>): boolean {
  if ("hidden" in attribs) return true;
  // aria-hidden text is usually drawn on screen (an icon's label, a price beside
  // its spoken form), but it is also a common way to put text in front of a
  // model and not a screen reader, so it is treated as hidden.
  if (attribs["aria-hidden"]?.toLowerCase() === "true") return true;
  if (name === "dialog" && !("open" in attribs)) return true;
  if (name === "input" && attribs.type?.toLowerCase() === "hidden") return true;
  const classes = attribs.class?.toLowerCase().split(/\s+/) ?? [];
  if (
    classes.some((c) => HIDING_CLASSES.has(c)) &&
    !classes.some((c) => RESPONSIVE_DISPLAY.test(c))
  ) {
    return true;
  }
  const style = attribs.style && stripCssComments(attribs.style.toLowerCase()).replace(/\s+/g, "");
  if (!style) return false;
  if (TINY_BOX.test(style) && CLIPPED.test(style)) return true;
  return HIDING_STYLES.some((pattern) => pattern.test(style));
}

/** An absolute http(s) URL for a link, or null for anything else (javascript:, data:, mailto:). */
function linkTarget(href: string | undefined, base: string): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Brackets are encoded so the URL can't close the Markdown link it sits in.
  return url.href.replace(/[()<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

const isHeading = (name: string) => /^h[1-6]$/.test(name);

type Skip = "non-text" | "hidden" | null;

/**
 * Extracts the visible text of an HTML page. `baseUrl` resolves relative links.
 *
 * Nesting is tracked with counters rather than by searching the open-element
 * stack, since unclosed tags can make that stack as deep as the page is long.
 */
export function extractVisibleText(html: string, baseUrl: string): ExtractedPage {
  const visible: string[] = [];
  const hidden: string[] = [];
  let hiddenLength = 0;
  let hiddenBlocks = 0;
  let title = "";
  let inTitle = false;

  const skips: Skip[] = [];
  let nonTextDepth = 0;
  let hiddenDepth = 0;
  let svgDepth = 0;
  // Whether the outermost open hidden element held any text, so empty hidden
  // wrappers (icons, spacers) aren't counted.
  let hiddenRegionHasText = false;
  let preDepth = 0;
  let openLink: { href: string | null; labelParts: string[] } | null = null;
  const write = (text: string) => (openLink?.labelParts ?? visible).push(text);

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        // An <svg> has a <title> of its own, and one inside a hidden element
        // isn't shown either; only the document's counts. It sits inside
        // <head>, which is skipped, so it is captured before the skip check.
        if (name === "title" && !title && svgDepth === 0 && hiddenDepth === 0) inTitle = true;
        if (name === "svg") svgDepth++;

        let skip: Skip = null;
        if (NON_TEXT.has(name)) skip = "non-text";
        else if (isHiddenElement(name, attribs)) skip = "hidden";
        skips.push(skip);
        if (skip === "non-text") nonTextDepth++;
        if (skip === "hidden") {
          if (hiddenDepth === 0) hiddenRegionHasText = false;
          hiddenDepth++;
        }
        if (nonTextDepth > 0 || hiddenDepth > 0) return;

        if (name === "pre") {
          preDepth++;
          write("\n\n");
        } else if (name === "a")
          openLink = { href: linkTarget(attribs.href, baseUrl), labelParts: [] };
        else if (name === "br") write("\n");
        else if (name === "li") write("\n- ");
        else if (isHeading(name)) write(`\n\n${"#".repeat(Number(name[1]))} `);
        else if (BLOCKS.has(name)) write("\n\n");
        else if (name === "td" || name === "th") write(" | ");
      },
      ontext(text) {
        if (inTitle) {
          title += text;
          return;
        }
        if (nonTextDepth > 0) return;
        if (hiddenDepth > 0) {
          if (text.trim()) {
            hiddenRegionHasText = true;
            if (hiddenLength < MAX_HIDDEN_CHARS) {
              hidden.push(text);
              hiddenLength += text.length;
            }
          }
          return;
        }
        write(preDepth > 0 ? text : text.replace(/\s+/g, " "));
      },
      onclosetag(name) {
        if (name === "title") inTitle = false;
        if (name === "svg") svgDepth = Math.max(0, svgDepth - 1);
        const skip = skips.pop();
        if (skip === "non-text") {
          nonTextDepth--;
          return;
        }
        if (skip === "hidden") {
          hiddenDepth--;
          if (hiddenDepth === 0 && hiddenRegionHasText) {
            hiddenBlocks++;
            hidden.push("\n");
          }
          return;
        }
        if (nonTextDepth > 0 || hiddenDepth > 0) return;

        if (name === "pre") {
          // A stray </pre> in malformed HTML must not push the depth negative.
          preDepth = Math.max(0, preDepth - 1);
          write("\n\n");
        } else if (name === "a" && openLink) {
          const { href, labelParts } = openLink;
          openLink = null;
          // Escaped so a bracket in the text can't end the label early.
          const label = labelParts
            .join("")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/[\\[\]]/g, "\\$&");
          if (!label) return;
          write(href ? `[${label}](${href})` : label);
        } else if (isHeading(name) || BLOCKS.has(name)) write("\n\n");
      },
    },
    { decodeEntities: true },
  );
  parser.write(html.replace(/\r\n?/g, "\n"));
  parser.end();

  const text = visible
    .join("")
    .replace(/\u00a0/g, " ")
    .split("\n")
    // trimEnd, not a `[ \t]+$` regex, which backtracks quadratically on a long run of spaces.
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    title: title.replace(/\s+/g, " ").trim(),
    text,
    hiddenBlocks,
    hiddenText: hidden.join(" "),
  };
}

/**
 * Removes `<!-- … -->` comments from text that isn't parsed as HTML, such as
 * Markdown, where a comment renders as nothing. Returns the comments separately
 * so they can be screened like hidden elements.
 */
export function stripHtmlComments(text: string): { text: string; comments: string[] } {
  const comments: string[] = [];
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("<!--", i);
    if (open === -1) return { text: out + text.slice(i), comments };
    out += text.slice(i, open);
    const close = text.indexOf("-->", open + 4);
    const end = close === -1 ? text.length : close;
    comments.push(text.slice(open + 4, end));
    i = close === -1 ? text.length : close + 3;
  }
  return { text: out, comments };
}

interface InjectionRule {
  reason: string;
  pattern: RegExp;
}

/**
 * Phrasings that address an AI reader rather than a person. A heuristic: it
 * catches the common shapes, and a match is surfaced to the user rather than
 * blocking the page, since articles about prompt injection quote these too.
 *
 * Every pattern must stay linear on pathological input — this runs on up to
 * 5MB of page text on the sidecar's event loop. Bounded windows like
 * `[^.\n]{0,40}` are fine; an unbounded quantifier next to `\s` is not.
 */
const INJECTION_RULES: InjectionRule[] = [
  {
    reason: "tells the reader to ignore its instructions",
    pattern:
      /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your)\b[^.\n]{0,40}\b(?:instructions?|prompts?|rules|directions|guidelines)\b/i,
  },
  {
    reason: "tries to give the reader a new role or new instructions",
    pattern:
      /\b(?:you are now|from now on,? you|your new (?:task|instructions?|role)|new instructions:)|\b(?:reveal|print|repeat|output)\b[^.\n]{0,20}\b(?:your|the) system prompt\b/i,
  },
  {
    reason: "contains chat-template or role markers",
    // Horizontal whitespace only around the role: `\s*` would also match the
    // newlines between lines and backtrack across every one of them.
    pattern:
      /<\|(?:im_start|im_end|system|endoftext)\|>|\[\/?INST\]|<\/?(?:system|assistant)>|^[ \t]*(?:system|assistant)[ \t]*:/im,
  },
  {
    reason: "addresses an AI assistant directly",
    pattern:
      /\b(?:attention|note|message|instructions?)[ \t]+(?:to|for)[ \t]+(?:the[ \t]+|any[ \t]+)?(?:ai|assistant|llm|language model|agent|chatbot)s?\b|\bif you are an? (?:ai|assistant|llm|language model|agent|bot)\b|\b(?:ai|llm|language model)s? (?:agents? )?reading this\b/i,
  },
  {
    reason: "asks for the user's data to be sent to a URL",
    pattern:
      /(?:https?:\/\/|\b(?:url|link|endpoint|query string)\b)[^\n]{0,80}\b(?:conversation|chat history|memories|system prompt|the user'?s (?:tasks|notes|memories|messages|data|conversation|chat))\b|\b(?:conversation|chat history|memories|system prompt|the user'?s (?:tasks|notes|memories|messages|data|conversation|chat))\b[^\n]{0,80}(?:https?:\/\/|\b(?:url|link|endpoint|query string)\b)/i,
  },
];

/** The reasons, in rule order, for every instruction-like pattern the text contains. */
export function detectInjection(text: string): string[] {
  return INJECTION_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.reason);
}
