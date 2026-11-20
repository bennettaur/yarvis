#!/usr/bin/env bun
/**
 * Builds yarvis-server for the release bundle.
 *
 * Tauri's `externalBin` expects the binary at
 * `src-tauri/binaries/yarvis-server-<target triple>` and bundles it beside the
 * app's own executable under the plain name `yarvis-server`, where
 * `src-tauri/src/local_server.rs` starts it. The triple comes from
 * `TAURI_ENV_TARGET_TRIPLE`, which `tauri build` sets for its
 * `beforeBuildCommand`, falling back to the host's for a manual run.
 *
 *   bun run server:compile
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";

const MANIFEST = "server/Cargo.toml";
const OUT_DIR = "src-tauri/binaries";

function exeSuffix(triple: string): string {
  return triple.includes("windows") ? ".exe" : "";
}

/** Where cargo writes the binary when built with `--target <triple>`. */
export function builtPath(triple: string): string {
  return `server/target/${triple}/release/yarvis-server${exeSuffix(triple)}`;
}

/** Where `externalBin` looks for the binary built for `triple`. */
export function outfile(triple: string): string {
  return `${OUT_DIR}/yarvis-server-${triple}${exeSuffix(triple)}`;
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
  const result = spawnSync(
    "cargo",
    ["build", "--release", "--locked", "--manifest-path", MANIFEST, "--target", triple],
    { stdio: "inherit" },
  );
  // `status` is null when cargo couldn't be started at all.
  if (result.error) console.error(result.error);
  if (result.status !== 0) process.exit(result.status ?? 1);
  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(builtPath(triple), outfile(triple));
}
