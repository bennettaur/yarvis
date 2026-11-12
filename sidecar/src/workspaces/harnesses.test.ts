import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgentHarnesses } from "./harnesses.ts";

let dir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-harnesses-"));
  originalPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

const writeSettings = (doc: Record<string, unknown>) =>
  writeFile(process.env.YARVIS_SETTINGS_PATH as string, JSON.stringify(doc));

describe("listAgentHarnesses", () => {
  const noEnv = {};

  it("lists only the built-in agent when nothing is configured", async () => {
    expect(await listAgentHarnesses(noEnv)).toEqual([
      { id: "claude", name: "Claude", kind: "claude-code", isDefault: true },
    ]);
  });

  it("lists the default and opted-in harnesses, without their commands or env", async () => {
    await writeSettings({
      agentName: "  ",
      agentHarnesses: [
        { id: "pi", name: "Pi", kind: "pi", command: "pi", env: { PI_KEY: "x" } },
        { id: "box", name: " ", kind: "sandboxy", command: "cloudbox run", assistantMayUse: true },
        { id: "yolo", name: "Yolo", kind: "claude-code", command: "claude --yolo" },
      ],
      defaultAgentHarness: "pi",
    });
    expect(await listAgentHarnesses(noEnv)).toEqual([
      { id: "claude", name: "Claude", kind: "claude-code", isDefault: false },
      { id: "pi", name: "Pi", kind: "pi", isDefault: true },
      { id: "box", name: "box", kind: "custom", isDefault: false },
    ]);
  });

  it("gives the built-in agent the kind its command makes it", async () => {
    await writeSettings({ agentCommand: "codex --yolo" });
    expect((await listAgentHarnesses(noEnv))[0]?.kind).toBe("custom");
    await writeSettings({ agentCommand: "FOO=1 /opt/bin/claude" });
    expect((await listAgentHarnesses(noEnv))[0]?.kind).toBe("claude-code");
    // The env override outranks the setting, as in the core.
    expect((await listAgentHarnesses({ YARVIS_CLAUDE_COMMAND: "aider" }))[0]?.kind).toBe("custom");
  });

  it("skips entries the core would not launch and falls back to the built-in default", async () => {
    await writeSettings({
      agentHarnesses: [
        "pi",
        null,
        { id: 3, command: "x", assistantMayUse: true },
        { id: "Bad Id", command: "x", assistantMayUse: true },
        { id: "nocmd", command: "  ", assistantMayUse: true },
        { id: "claude", command: "claude", assistantMayUse: true },
      ],
      defaultAgentHarness: "nocmd",
    });
    expect(await listAgentHarnesses(noEnv)).toEqual([
      { id: "claude", name: "Claude", kind: "claude-code", isDefault: true },
    ]);
  });
});
