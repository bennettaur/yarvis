import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeWorkspaceFolder } from "./workspaceFolder.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A workspace folder holding what provisioning writes. */
function workspaceFolder(slug = "my-work"): string {
  const parent = mkdtempSync(join(tmpdir(), "yarvis-wsf-"));
  tmpDirs.push(parent);
  const root = join(parent, slug);
  mkdirSync(join(root, ".claude", "skills"), { recursive: true });
  mkdirSync(join(root, ".yarvis"));
  writeFileSync(join(root, ".yarvis", "brief.md"), "");
  writeFileSync(join(root, "AGENTS.md"), "");
  writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md");
  writeFileSync(join(root, ".mcp.json"), "{}");
  return root;
}

describe("removeWorkspaceFolder", () => {
  it("deletes a folder holding only what Yarvis wrote", async () => {
    const root = workspaceFolder();
    await removeWorkspaceFolder(root, "my-work", { force: false });
    expect(existsSync(root)).toBe(false);
  });

  it("names what else is there without force, and deletes it with force", async () => {
    const root = workspaceFolder();
    writeFileSync(join(root, "notes.md"), "");
    mkdirSync(join(root, "femr-wire"));

    await expect(removeWorkspaceFolder(root, "my-work", { force: false })).rejects.toThrow(
      "(femr-wire, notes.md)",
    );
    expect(existsSync(join(root, "notes.md"))).toBe(true);

    await removeWorkspaceFolder(root, "my-work", { force: true });
    expect(existsSync(root)).toBe(false);
  });

  it("counts the user's own entries in .claude as leftover, but not Yarvis's copies", async () => {
    const root = workspaceFolder();
    mkdirSync(join(root, ".claude", "skills", "copied"));
    mkdirSync(join(root, ".claude", "skills", "mine"));
    writeFileSync(
      join(root, ".claude", ".yarvis-copied.json"),
      '{"skills":["copied"],"agents":[]}',
    );
    writeFileSync(join(root, ".claude", "settings.json"), "{}");
    writeFileSync(join(root, ".claude", "settings.local.json"), "{}");

    await expect(removeWorkspaceFolder(root, "my-work", { force: false })).rejects.toThrow(
      "(.claude/settings.local.json, .claude/skills/mine)",
    );
  });

  it("deletes Finder's .DS_Store and a folder with no .claude", async () => {
    const root = workspaceFolder();
    writeFileSync(join(root, ".DS_Store"), "");
    rmSync(join(root, ".claude"), { recursive: true });
    await removeWorkspaceFolder(root, "my-work", { force: false });
    expect(existsSync(root)).toBe(false);
  });

  it("counts a .claude/skills that isn't a folder as the user's", async () => {
    const root = workspaceFolder();
    rmSync(join(root, ".claude", "skills"), { recursive: true });
    writeFileSync(join(root, ".claude", "skills"), "");
    await expect(removeWorkspaceFolder(root, "my-work", { force: false })).rejects.toThrow(
      "(.claude/skills)",
    );
  });

  it("does nothing when the folder is already gone", async () => {
    const root = workspaceFolder();
    rmSync(root, { recursive: true });
    await removeWorkspaceFolder(root, "my-work", { force: false });
  });

  it("never deletes a folder that isn't named after the workspace, even with force", async () => {
    const root = workspaceFolder();
    for (const slug of ["other", "..", ""]) {
      await expect(removeWorkspaceFolder(root, slug, { force: true })).rejects.toThrow(
        "isn't named after its workspace",
      );
    }
    expect(existsSync(root)).toBe(true);
  });
});
