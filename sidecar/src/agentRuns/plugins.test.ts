import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  INPUTS_AND_TRUST_MARKER,
  REREVIEW_INPUTS_AND_TRUST_MARKER,
  withInputsAndTrust,
  writePluginCopy,
} from "./plugins.ts";

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

  it("ships every file in the plugin's source folder, agents with the shared section", () => {
    const source = join(import.meta.dir, "../../claude-plugins/yarvis-review");
    const shared = readFileSync(join(source, "shared/inputs-and-trust.md"), "utf8").trim();
    const rereviewShared = readFileSync(
      join(source, "shared/rereview-inputs-and-trust.md"),
      "utf8",
    ).trim();
    const copy = writePluginCopy("yarvis-review");
    try {
      const sourceFiles = readdirSync(source, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(source, join(entry.parentPath, entry.name)))
        // Spliced into the agents rather than shipped.
        .filter((path) => !path.startsWith("shared/"))
        .sort();
      expect(sourceFiles).toContain("skills/verification-report/SKILL.md");
      const agents = sourceFiles.filter((path) => path.startsWith("agents/"));
      expect(agents).toHaveLength(8);
      for (const path of sourceFiles) {
        const shipped = readFileSync(join(copy.dir, path), "utf8");
        const original = readFileSync(join(source, path), "utf8");
        if (path === "agents/rereviewer.md") {
          expect(shipped).toBe(original.replace(REREVIEW_INPUTS_AND_TRUST_MARKER, rereviewShared));
          expect(shipped).toContain("index.md");
          expect(shipped).not.toContain(REREVIEW_INPUTS_AND_TRUST_MARKER);
        } else if (path.startsWith("agents/")) {
          expect(shipped).toBe(original.replace(INPUTS_AND_TRUST_MARKER, shared));
          expect(shipped).toContain("## Inputs and trust");
          expect(shipped).not.toContain(INPUTS_AND_TRUST_MARKER);
        } else {
          expect(shipped).toBe(original);
        }
      }
      expect(existsSync(join(copy.dir, "shared"))).toBe(false);
    } finally {
      copy.remove();
    }
  });

  it("refuses an agent without exactly one shared-section marker", () => {
    expect(() => withInputsAndTrust("no marker", "x")).toThrow("exactly once");
    expect(() =>
      withInputsAndTrust(`${INPUTS_AND_TRUST_MARKER}\n${INPUTS_AND_TRUST_MARKER}`, "x"),
    ).toThrow("exactly once");
    expect(withInputsAndTrust(`a\n${INPUTS_AND_TRUST_MARKER}\nb`, "  shared \n")).toBe(
      "a\nshared\nb",
    );
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
