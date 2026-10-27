import { posix } from "./imports";

/**
 * A stand-in module that lets the TypeScript worker resolve one tsconfig
 * alias (`@/lib/x`) the way the repo's compiler would, without global
 * compiler options. The worker has no tsconfig, but it does look up a bare
 * specifier in `node_modules` folders up the importing file's path, and
 * `review://` URIs keep each PR's files under their own root. So a module at
 * `<config dir>/node_modules/@/lib/x.ts` that re-exports the real file is
 * found only by files under that config, in that PR. Go-to-definition follows
 * the re-export to the real declaration; only a jump on the module string
 * itself lands on the stand-in, which the host maps back to its target.
 */
export interface AliasShim {
  /** Where the stand-in lives in the PR's head (never a real file). */
  path: string;
  /** The file the alias resolves to. */
  target: string;
  content: string;
}

/** A specifier made only of path-safe segments: no wildcards, escapes or `..`. */
const SAFE_SEGMENT = /^[\w@$~+().-]+$/;
const SOURCE_EXTENSION = /(?:\.d)?\.(?:[cm]?[jt]s|[jt]sx)$/;

/** `to` relative to the folder `from`, as an import names it (`./x`, `../y/z`). */
function relativeImport(from: string, to: string): string {
  const fromParts = from ? from.split("/") : [];
  const toParts = to.split("/");
  let shared = 0;
  while (
    shared < fromParts.length &&
    shared < toParts.length - 1 &&
    fromParts[shared] === toParts[shared]
  ) {
    shared++;
  }
  const up = fromParts.length - shared;
  const rest = toParts.slice(shared).join("/");
  return up === 0 ? `./${rest}` : `${"../".repeat(up)}${rest}`;
}

/**
 * The stand-in for `specifier` resolving to `target` under the config in
 * `configDir`, or null for a specifier that can't safely name a file or a
 * stand-in that would sit on a real one.
 */
export function aliasShim(
  specifier: string,
  target: string,
  configDir: string,
  tree: ReadonlySet<string>,
): AliasShim | null {
  const segments = specifier.split("/");
  if (segments.some((s) => s === "." || s === ".." || !SAFE_SEGMENT.test(s))) return null;
  const stem = specifier.replace(SOURCE_EXTENSION, "");
  const path = `${configDir ? `${configDir}/` : ""}node_modules/${stem}.ts`;
  if (tree.has(path)) return null;
  const from = JSON.stringify(
    relativeImport(posix.dirname(path), target.replace(SOURCE_EXTENSION, "")),
  );
  return {
    path,
    target,
    // `export *` leaves out a default export, so it is re-exported by name.
    content: `export * from ${from};\nexport { default } from ${from};\n`,
  };
}
