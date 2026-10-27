/** The parts of a TypeScript `DefinitionInfo` the review editor reads. */
export interface WorkerDefinition {
  fileName: string;
  kind: string;
  textSpan: { start: number; length: number };
}

/**
 * Whether every definition the worker found is an import binding in the asking
 * file itself. That is what an import whose module didn't resolve answers with
 * (kind `alias`), however its statement is wrapped, and it is no answer: the
 * jump should go to the text search instead.
 */
export function onlyUnresolvedImports(
  entries: readonly Pick<WorkerDefinition, "fileName" | "kind">[],
  self: string,
): boolean {
  return entries.length > 0 && entries.every((e) => e.fileName === self && e.kind === "alias");
}
