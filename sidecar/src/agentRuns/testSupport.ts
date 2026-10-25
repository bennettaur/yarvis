import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { ClaudeRunOptions } from "./service.ts";

/** Shared by the agent-run tests: stand-ins for `claude` and the options a run needs. */

export const FIXTURES = join(import.meta.dir, "fixtures");

export function testConfig(databaseUrl: string | undefined, root: string): Config {
  return {
    port: 0,
    token: "test-token",
    tokenGenerated: false,
    attentionToken: "test-attention-token",
    mcpToken: "test-mcp-token",
    allowedOrigins: null,
    databaseUrl,
    workspacesRoot: root,
    secrets: {},
    customProviderSecrets: {},
    mcpSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  };
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Writes an executable shell script standing in for `claude`. */
export function fakeClaude(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A fake that prints the given stream-json lines. */
export function fakePrinting(dir: string, name: string, lines: unknown[]): string {
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return fakeClaude(dir, name, `cat "${file}"`);
}

/** A `result` line, as Claude Code ends a run. */
export function resultLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    total_cost_usd: 0.01,
    duration_ms: 1000,
    session_id: "session-1",
    ...overrides,
  };
}

export function runOptions<T = unknown, R = T>(
  cwd: string,
  overrides: Partial<ClaudeRunOptions<T, R>> = {},
): ClaudeRunOptions<T, R> {
  return {
    kind: "test-kind",
    targetKey: "gh:o/r/1",
    cwd,
    prompt: "count the files",
    allowedTools: ["Read"],
    maxBudgetUsd: 1,
    timeoutMs: 10_000,
    ...overrides,
  };
}
