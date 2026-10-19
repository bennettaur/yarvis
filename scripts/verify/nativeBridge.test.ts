/**
 * Keeps the frontend's privileged Tauri commands in the files `tier.ts` marks
 * high risk, so the rest of `src/` can count as low risk. These checks guard
 * against mistakes, not a hostile author: obfuscated code can get past any
 * static check, and only trusted authors' PRs can auto-merge.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PRIVILEGED_FRONTEND_FILES } from "./tier.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Commands that write a secret, pick the secret store, or type into or launch a shell. */
const PRIVILEGED_COMMANDS: Record<string, string> = {
  set_secret: "src/lib/privilegedCommands.ts",
  delete_secret: "src/lib/privilegedCommands.ts",
  set_mcp_secret: "src/lib/privilegedCommands.ts",
  delete_mcp_secret: "src/lib/privilegedCommands.ts",
  delete_mcp_all_secrets: "src/lib/privilegedCommands.ts",
  set_custom_provider_secret: "src/lib/privilegedCommands.ts",
  delete_custom_provider_secret: "src/lib/privilegedCommands.ts",
  delete_custom_provider_all_secrets: "src/lib/privilegedCommands.ts",
  set_embeddings_secret: "src/lib/privilegedCommands.ts",
  delete_embeddings_secret: "src/lib/privilegedCommands.ts",
  set_secret_backend: "src/lib/privilegedCommands.ts",
  set_agent: "src/lib/privilegedCommands.ts",
  pty_write: "src/lib/pty.ts",
  pty_start_claude: "src/lib/pty.ts",
};

const CORE_IMPORT = 'import { invoke } from "@tauri-apps/api/core";';
/** A call whose command is a string literal, with or without a type argument. */
const LITERAL_CALL = /\binvoke(?:<[^(]*>)?\(\s*"([a-z_]+)"/g;

function frontendSources(dir = join(REPO_ROOT, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : frontendSources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const sources = frontendSources().map((path) => ({
  path: relative(REPO_ROOT, path),
  text: readFileSync(path, "utf8"),
}));

describe("the frontend's native bridge", () => {
  it("reaches Tauri only through the plain invoke import", () => {
    const offenders = sources.filter(({ text }) => {
      if (/__TAURI/.test(text)) return true;
      const mentions = text.split("@tauri-apps/api/core").length - 1;
      const imports = text.split(CORE_IMPORT).length - 1;
      return mentions !== imports;
    });
    expect(offenders.map((s) => s.path)).toEqual([]);
  });

  it("names every command as a string literal", () => {
    // Anything else, like `invoke(name)` or passing `invoke` around, would hide which command runs.
    const offenders = sources
      .filter(({ text }) => text.includes(CORE_IMPORT))
      .filter(({ text }) => {
        const uses = text.match(/\binvoke\b/g)?.length ?? 0;
        const literalCalls = [...text.matchAll(LITERAL_CALL)].length;
        return uses !== literalCalls + 1;
      });
    expect(offenders.map((s) => s.path)).toEqual([]);
  });

  it("calls each privileged command only from its own high-risk file", () => {
    const misplaced = sources.flatMap(({ path, text }) =>
      [...text.matchAll(LITERAL_CALL)]
        .map((match) => match[1])
        .filter((command) => PRIVILEGED_COMMANDS[command] && PRIVILEGED_COMMANDS[command] !== path)
        .map((command) => `${command} in ${path}`),
    );
    expect(misplaced).toEqual([]);
  });

  it("marks every file allowed a privileged command as high risk", () => {
    const owners = [...new Set(Object.values(PRIVILEGED_COMMANDS))].sort();
    expect([...PRIVILEGED_FRONTEND_FILES].sort()).toEqual(owners);
  });
});
