import { languageForPath } from "../../../lib/highlight";

/**
 * highlight.js grammar names (what {@link languageForPath} answers with) to
 * Monaco's language ids. Only the names that differ are listed; anything
 * Monaco has no tokenizer for falls to plain text.
 */
const MONACO_BY_HLJS: Record<string, string | null> = {
  bash: "shell",
  erlang: null,
  haskell: null,
  makefile: null,
  objectivec: "objective-c",
  protobuf: "proto",
};

/**
 * Extensions highlight.js reads with a coarser grammar than Monaco offers.
 * HTML especially: Monaco's HTML mode has its own worker, where highlight.js
 * reads it as XML.
 */
const MONACO_BY_EXTENSION: Record<string, string> = {
  htm: "html",
  html: "html",
};

/** The Monaco language id for a path, `plaintext` when there is none. */
export function monacoLanguageForPath(path: string): string {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  const byExtension = dot > 0 ? MONACO_BY_EXTENSION[name.slice(dot + 1)] : undefined;
  if (byExtension) return byExtension;
  const hljs = languageForPath(path);
  if (!hljs) return "plaintext";
  const mapped = hljs in MONACO_BY_HLJS ? MONACO_BY_HLJS[hljs] : hljs;
  return mapped ?? "plaintext";
}
