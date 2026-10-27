// The review editor's public surface. Nothing here imports Monaco itself; it
// loads on the first mount of a view, or the first `addExtraModel`.
export { monacoLanguageForPath } from "./language";
export { loadMonaco } from "./loader";
export { MonacoDiffView, type MonacoDiffViewProps } from "./MonacoDiffView";
export { MonacoFileView, type MonacoFileViewProps } from "./MonacoFileView";
export { addExtraModel } from "./models";
export {
  type DefinitionTarget,
  type NavigationProvider,
  type OpenLocationHandler,
  registerNavigationProvider,
  uriKey,
  useMonacoNavigation,
} from "./navigation";
export { onlyUnresolvedImports } from "./tsDefinitions";
export type {
  DiffSide,
  EditorRange,
  EditorZone,
  LineAction,
  LineActionKind,
  LineDecoration,
  ModelSide,
} from "./types";
export {
  type ParsedReviewUri,
  parseReviewUri,
  REVIEW_SCHEME,
  reviewUri,
  SNAPSHOT_SCHEME,
  snapshotUri,
} from "./uri";
