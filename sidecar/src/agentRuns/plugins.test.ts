import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializePlugin, pluginHash } from "./plugins.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yarvis-plugins-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("writing out a shipped plugin", () => {
  it("writes the bundled yarvis-review plugin as Claude Code expects to find it", () => {
    const dir = materializePlugin("yarvis-review", root);
    expect(dir).toBe(join(root, "yarvis-review"));
    const manifest = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("yarvis-review");
    expect(existsSync(join(dir, "README.md"))).toBe(true);
  });

  it("leaves an unchanged copy alone", () => {
    const files = { "agents/a.md": "one" };
    const dir = materializePlugin("yarvis-review", root, files);
    const before = statSync(join(dir, "agents", "a.md")).ino;
    materializePlugin("yarvis-review", root, files);
    expect(statSync(join(dir, "agents", "a.md")).ino).toBe(before);
  });

  it("replaces the copy when the bundled content changes, dropping removed files", () => {
    const dir = materializePlugin("yarvis-review", root, { "agents/a.md": "one" });
    materializePlugin("yarvis-review", root, { "agents/b.md": "two" });
    expect(existsSync(join(dir, "agents", "a.md"))).toBe(false);
    expect(readFileSync(join(dir, "agents", "b.md"), "utf8")).toBe("two");
    // Nothing staged or retired is left beside it.
    expect(readdirSync(root)).toEqual(["yarvis-review"]);
  });

  it("rewrites a copy someone edited by hand, since its hash no longer matches what it holds", () => {
    const dir = materializePlugin("yarvis-review", root, { "agents/a.md": "one" });
    writeFileSync(join(dir, ".yarvis-content-hash"), "stale\n");
    writeFileSync(join(dir, "agents", "a.md"), "tampered");
    materializePlugin("yarvis-review", root, { "agents/a.md": "one" });
    expect(readFileSync(join(dir, "agents", "a.md"), "utf8")).toBe("one");
  });

  it("refuses a listed path that leaves the plugin folder", () => {
    mkdirSync(join(root, "elsewhere"));
    expect(() => materializePlugin("yarvis-review", root, { "../elsewhere/x.md": "no" })).toThrow(
      "escapes",
    );
    expect(existsSync(join(root, "elsewhere", "x.md"))).toBe(false);
  });
});

describe("the content hash", () => {
  it("changes when a file is renamed, not only when its content does", () => {
    expect(pluginHash({ "a.md": "x" })).not.toBe(pluginHash({ "b.md": "x" }));
    expect(pluginHash({ "a.md": "x", "b.md": "y" })).toBe(pluginHash({ "b.md": "y", "a.md": "x" }));
  });
});
