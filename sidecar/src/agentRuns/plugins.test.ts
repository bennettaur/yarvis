import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { writePluginCopy } from "./plugins.ts";

describe("writing out a shipped plugin", () => {
  it("writes the bundled yarvis-review plugin as Claude Code expects to find it", () => {
    const copy = writePluginCopy("yarvis-review");
    try {
      expect(copy.dir.endsWith("/yarvis-review")).toBe(true);
      const manifest = JSON.parse(
        readFileSync(join(copy.dir, ".claude-plugin", "plugin.json"), "utf8"),
      );
      expect(manifest.name).toBe("yarvis-review");
      expect(existsSync(join(copy.dir, "README.md"))).toBe(true);
    } finally {
      copy.remove();
    }
  });

  it("ships every file in the plugin's source folder", () => {
    const source = join(import.meta.dir, "../../claude-plugins/yarvis-review");
    const copy = writePluginCopy("yarvis-review");
    try {
      const sourceFiles = readdirSync(source, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(source, join(entry.parentPath, entry.name)))
        .sort();
      expect(sourceFiles).toContain("skills/verification-report/SKILL.md");
      for (const path of sourceFiles) {
        expect(readFileSync(join(copy.dir, path), "utf8")).toBe(
          readFileSync(join(source, path), "utf8"),
        );
      }
    } finally {
      copy.remove();
    }
  });

  it("gives each run its own private copy, holding only the listed files", () => {
    const first = writePluginCopy("yarvis-review", { "agents/a.md": "one" });
    const second = writePluginCopy("yarvis-review", { "agents/a.md": "one" });
    try {
      expect(first.dir).not.toBe(second.dir);
      expect(readdirSync(join(first.dir, "agents"))).toEqual(["a.md"]);
      // Only the user can read or change it.
      expect(statSync(dirname(first.dir)).mode & 0o077).toBe(0);
    } finally {
      first.remove();
      second.remove();
    }
  });

  it("removes the copy when asked", () => {
    const copy = writePluginCopy("yarvis-review", { "agents/a.md": "one" });
    copy.remove();
    expect(existsSync(dirname(copy.dir))).toBe(false);
  });

  it("refuses a listed path that leaves the plugin folder, leaving nothing behind", () => {
    expect(() => writePluginCopy("yarvis-review", { "../x.md": "no" })).toThrow("escapes");
    expect(() => writePluginCopy("yarvis-review", { "/etc/x.md": "no" })).toThrow("escapes");
  });
});
