/**
 * Markdown imported as text — how the shipped agent definitions reach the code.
 * Bun resolves `with { type: "text" }` at build time and embeds the contents in
 * the compiled binary, so a definition can be a reviewable file in the repo and
 * still exist in a distributed build with no filesystem to read from.
 */
declare module "*.md" {
  const content: string;
  export default content;
}
