#!/usr/bin/env bun
/**
 * Compiles the sidecar into a single executable for a release build.
 *
 * Tauri's `externalBin` expects the binary at
 * `src-tauri/binaries/yarvis-sidecar-<target triple>`, and bundles it beside
 * the app's own executable under the plain name `yarvis-sidecar`. The triple
 * comes from `TAURI_ENV_TARGET_TRIPLE`, which `tauri build` sets for its
 * `beforeBuildCommand`, falling back to the host's for a manual run.
 *
 *   bun run sidecar:compile
 */

import { spawnSync } from "node:child_process";

const ENTRY = "sidecar/src/server.ts";
const OUT_DIR = "src-tauri/binaries";

/** The Rust target triples a release is built for, and Bun's name for each. */
const BUN_TARGETS: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
};

export function bunTarget(triple: string): string {
  const target = BUN_TARGETS[triple];
  if (!target) {
    throw new Error(`no Bun compile target for ${triple}`);
  }
  return target;
}

/** Where `externalBin` looks for the binary built for `triple`. */
export function outfile(triple: string): string {
  const ext = triple.includes("windows") ? ".exe" : "";
  return `${OUT_DIR}/yarvis-sidecar-${triple}${ext}`;
}

/** Reads the host triple from `rustc -vV`, as Tauri itself does. */
function hostTriple(): string {
  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = result.stdout?.match(/^host: (\S+)$/m)?.[1];
  if (!host) {
    throw new Error("could not read the host target triple from `rustc -vV`");
  }
  return host;
}

if (import.meta.main) {
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
  const args = [
    "build",
    "--compile",
    `--target=${bunTarget(triple)}`,
    ENTRY,
    "--outfile",
    outfile(triple),
  ];
  // The Bun running this script is the runtime the binary embeds, not whichever
  // `bun` comes first on PATH.
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}
