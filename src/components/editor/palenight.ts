import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { PALENIGHT as P } from "../../lib/palette";

/** Palenight's token colours, matching the diff views' `.syntax` rules in `index.css`. */
const palenightHighlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.quote], color: P.comment, fontStyle: "italic" },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: P.purple },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: P.blue },
  { tag: [t.typeName, t.className, t.namespace, t.attributeName], color: P.yellow },
  { tag: [t.string, t.special(t.string), t.inserted], color: P.green },
  { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.variableName)], color: P.orange },
  {
    tag: [t.operator, t.punctuation, t.regexp, t.escape, t.url, t.propertyName],
    color: P.cyan,
  },
  { tag: [t.tagName, t.variableName, t.deleted, t.invalid], color: P.red },
  { tag: [t.heading, t.strong], fontWeight: "bold", color: P.blue },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, textDecoration: "underline" },
]);

export const palenightHighlighting = syntaxHighlighting(palenightHighlightStyle);
