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

/** Inline style declarations that keep text off screen, matched with whitespace removed. */
const HIDING_STYLES = [
  /(?:^|;)display:none/,
  /(?:^|;)visibility:(?:hidden|collapse)/,
  /(?:^|;)opacity:(?:0+(?:\.0*)?|\.0+)(?:;|$|!)/,
  /(?:^|;)font-size:0+(?:\.0+)?(?:px|em|rem|pt|%)?(?:;|$|!)/,
  /(?:^|;)color:transparent/,
  /(?:^|;)(?:text-indent|left|top):-\d{4,}/,
  /(?:^|;)clip:rect\(0/,
  /(?:^|;)clip-path:inset\(50%/,
];

/** A zero-sized box hides its text only when its overflow is clipped too. */
const ZERO_SIZE = /(?:^|;)(?:max-)?(?:height|width):0+(?:px)?(?:;|$|!)/;
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

function hides(name: string, attribs: Record<string, string>): boolean {
  if ("hidden" in attribs) return true;
  if (attribs["aria-hidden"]?.toLowerCase() === "true") return true;
  if (name === "dialog" && !("open" in attribs)) return true;
  if (name === "input" && attribs.type?.toLowerCase() === "hidden") return true;
  const classes = attribs.class?.toLowerCase().split(/\s+/) ?? [];
  if (classes.some((c) => HIDING_CLASSES.has(c))) return true;
  const style = attribs.style?.toLowerCase().replace(/\s+/g, "");
  if (!style) return false;
  if (ZERO_SIZE.test(style) && CLIPPED.test(style)) return true;
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

interface OpenElement {
  name: string;
  skip: "non-text" | "hidden" | null;
}

/** Extracts the visible text of an HTML page. `baseUrl` resolves relative links. */
export function extractVisibleText(html: string, baseUrl: string): ExtractedPage {
  const out: string[] = [];
  const hidden: string[] = [];
  let hiddenLength = 0;
  let hiddenBlocks = 0;
  let title = "";
  let inTitle = false;

  const stack: OpenElement[] = [];
  let skipDepth = 0;
  // Whether the hidden element currently open at the top of a skipped region held text.
  let hiddenRegionHasText = false;
  let preDepth = 0;
  let openLink: { href: string | null; label: string[] } | null = null;
  const write = (text: string) => (openLink?.label ?? out).push(text);

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === "title" && !title && !stack.some((e) => e.name === "svg")) inTitle = true;

        let skip: OpenElement["skip"] = null;
        if (NON_TEXT.has(name)) skip = "non-text";
        else if (hides(name, attribs)) skip = "hidden";
        stack.push({ name, skip });
        if (skip) {
          if (skipDepth === 0 && skip === "hidden") hiddenRegionHasText = false;
          skipDepth++;
        }
        if (skipDepth > 0) return;

        if (name === "pre") preDepth++;
        else if (name === "a") openLink = { href: linkTarget(attribs.href, baseUrl), label: [] };
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
        if (skipDepth > 0) {
          const outer = stack.find((e) => e.skip);
          if (outer?.skip === "hidden" && text.trim()) {
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
        const element = stack.pop();
        if (element?.skip) {
          skipDepth--;
          if (skipDepth === 0 && element.skip === "hidden" && hiddenRegionHasText) {
            hiddenBlocks++;
            hidden.push("\n");
          }
          return;
        }
        if (skipDepth > 0) return;

        if (name === "pre") preDepth = Math.max(0, preDepth - 1);
        else if (name === "a" && openLink) {
          const { href, label: parts } = openLink;
          openLink = null;
          const label = parts
            .join("")
            .trim()
            .replace(/[\\[\]]/g, "\\$&");
          if (!label) return;
          write(href ? `[${label}](${href})` : label);
        } else if (isHeading(name) || BLOCKS.has(name) || name === "pre") write("\n\n");
      },
    },
    { decodeEntities: true },
  );
  parser.write(html.replace(/\r\n?/g, "\n"));
  parser.end();

  const text = out
    .join("")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
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

interface InjectionRule {
  reason: string;
  pattern: RegExp;
}

/**
 * Phrasings that address an AI reader rather than a person. A heuristic: it
 * catches the common shapes, and a match is surfaced to the user rather than
 * blocking the page, since articles about prompt injection quote these too.
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
      /\b(?:you are now|from now on,? you|your new (?:task|instructions?|role)|new instructions:|developer mode|system prompt)\b/i,
  },
  {
    reason: "contains chat-template or role markers",
    pattern:
      /<\|(?:im_start|im_end|system|endoftext)\|>|\[\/?INST\]|<\/?(?:system|assistant|user)>|^\s*(?:system|assistant)\s*:/im,
  },
  {
    reason: "addresses an AI assistant directly",
    pattern:
      /\b(?:attention|note|message|instructions?)\s+(?:to|for)\s+(?:the\s+|any\s+)?(?:ai|assistant|llm|language model|agent|chatbot)s?\b|\bif you are an? (?:ai|assistant|llm|language model|agent|bot)\b/i,
  },
  {
    reason: "asks for conversation data or credentials to be sent somewhere",
    pattern:
      /\b(?:send|post|forward|email|upload|fetch|visit|append|include)\b[^.\n]{0,60}\b(?:conversation|chat history|memories|system prompt|api keys?|credentials|access tokens?)\b/i,
  },
];

/** The reasons, in rule order, for every instruction-like pattern the text contains. */
export function detectInjection(text: string): string[] {
  return INJECTION_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.reason);
}
