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
  it("lists only the built-in agent when nothing is configured", async () => {
    expect(await listAgentHarnesses()).toEqual([
      { id: "claude", name: "Claude", kind: "built-in", isDefault: true },
    ]);
  });

  it("lists configured harnesses and marks the default, without their commands or env", async () => {
    await writeSettings({
      agentName: "Claude",
      agentHarnesses: [
        { id: "pi", name: "Pi", kind: "pi", command: "pi", env: { PI_KEY: "x" } },
        { id: "box", name: "CloudBox", kind: "sandboxy", command: "cloudbox run" },
      ],
      defaultAgentHarness: "pi",
    });
    expect(await listAgentHarnesses()).toEqual([
      { id: "claude", name: "Claude", kind: "built-in", isDefault: false },
      { id: "pi", name: "Pi", kind: "pi", isDefault: true },
      { id: "box", name: "CloudBox", kind: "custom", isDefault: false },
    ]);
  });

  it("skips entries the core would not launch and falls back to the built-in default", async () => {
    await writeSettings({
      agentHarnesses: [
        { id: "Bad Id", command: "x" },
        { id: "nocmd", command: "  " },
        { id: "claude", command: "claude" },
      ],
      defaultAgentHarness: "nocmd",
    });
    expect(await listAgentHarnesses()).toEqual([
      { id: "claude", name: "Claude", kind: "built-in", isDefault: true },
    ]);
  });
});
