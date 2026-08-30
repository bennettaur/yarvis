import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBriefDocument, WORKSPACE_BRIEF_FILE, writeWorkspaceBrief } from "./brief.ts";

describe("writeWorkspaceBrief", () => {
  it("writes the brief under .yarvis/ and returns the absolute path", async () => {
    const root = mkdtempSync(join(tmpdir(), "yarvis-brief-"));
    try {
      const path = await writeWorkspaceBrief(root, "the brief body");
      expect(path).toBe(join(root, WORKSPACE_BRIEF_FILE));
      expect(readFileSync(path, "utf8")).toBe("the brief body");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("overwrites a brief left by an earlier provision rather than appending", async () => {
    const root = mkdtempSync(join(tmpdir(), "yarvis-brief-"));
    try {
      await writeWorkspaceBrief(root, "first");
      const path = await writeWorkspaceBrief(root, "second");
      expect(readFileSync(path, "utf8")).toBe("second");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildBriefDocument", () => {
  it("names the workspace and keeps the brief body", () => {
    const doc = buildBriefDocument("Rename the API", "  Drop the v1 prefix.  ");

    expect(doc).toBe(
      'Work on the following in the "Rename the API" workspace.\n\nDrop the v1 prefix.\n',
    );
  });
});
