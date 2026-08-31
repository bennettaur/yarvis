import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { useState } from "react";
import { draftKey, getDraft, resetDrafts, setDraft } from "../../lib/fileDrafts";
import type { WorkspaceFile } from "../../lib/workspaces";
import { mountForInteraction } from "../../test/render";

const fileOf = (path: string, content: string, hash: string): WorkspaceFile => ({
  path,
  content,
  unreadable: null,
  hash,
  size: content.length,
});

/** The hashes the fixture files are served with, and so what an edit made in a
 *  test is based on. */
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let file: WorkspaceFile = fileOf("src/a.ts", "const a = 1;\n", HASH_A);
/** Served instead of `file` for the paths listed here, so a test can flip a tab
 *  between two real files. */
let filesByPath: Record<string, WorkspaceFile> = {};
let saved: { path: string; content: string; expectedHash: string }[] = [];
/** Set to have the next save be refused the way a concurrent write is. */
let conflictOnSave = false;
let loadError: string | null = null;

const actual = await import("../../lib/workspaces");
mock.module("../../lib/workspaces", () => ({
  ...actual,
  workspaceRepoFile: async (_workspaceId: string, _repoId: string, path: string) => {
    if (loadError) throw new Error(loadError);
    return filesByPath[path] ?? file;
  },
  saveWorkspaceRepoFile: async (
    _workspaceId: string,
    _repoId: string,
    path: string,
    content: string,
    expectedHash: string,
  ) => {
    if (conflictOnSave) throw new actual.FileConflictError("changed on disk");
    saved.push({ path, content, expectedHash });
    return { hash: HASH_B, size: content.length };
  },
}));

// The editor itself is CodeMirror, which owns a live DOM of its own. These tests
// are about the tab around it — what it loads, what it refuses, and what it
// saves — so it is replaced with a marker.
mock.module("../editor/CodeEditor", () => ({
  default: ({ value }: { value: string }) => <pre data-testid="editor">{value}</pre>,
}));

const { default: WorkspaceFileEditor } = await import("./WorkspaceFileEditor");

const KEY = draftKey("ws-1", "wr-1", "src/a.ts");
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

let unmount: (() => void) | null = null;

beforeEach(() => {
  resetDrafts();
  saved = [];
  filesByPath = {};
  conflictOnSave = false;
  loadError = null;
  file = fileOf("src/a.ts", "const a = 1;\n", HASH_A);
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

const mount = async () => {
  const mounted = await mountForInteraction(
    <WorkspaceFileEditor workspaceId="ws-1" repoId="wr-1" path="src/a.ts" />,
  );
  unmount = mounted.unmount;
  return mounted.host;
};

/**
 * Mounts the editor under a wrapper that owns `path`, so a test can point the
 * same component at another file — what a tab switch does when the caller has
 * not keyed the editor. The component has to survive that on its own.
 */
let showFile: ((path: string) => void) | null = null;

function SwitchableEditor() {
  const [path, setPath] = useState("src/a.ts");
  showFile = setPath;
  return <WorkspaceFileEditor workspaceId="ws-1" repoId="wr-1" path={path} />;
}

const mountSwitchable = async () => {
  const mounted = await mountForInteraction(<SwitchableEditor />);
  unmount = mounted.unmount;
  return mounted.host;
};

const switchTo = async (path: string) => {
  showFile?.(path);
  await settle();
};

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label));

describe("WorkspaceFileEditor", () => {
  it("shows the file's contents", async () => {
    const host = await mount();
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe("const a = 1;\n");
  });

  it("shows a draft instead of what is on disk, and marks the file dirty", async () => {
    setDraft(KEY, { text: "const a = 2;\n", baseHash: HASH_A });
    const host = await mount();
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe("const a = 2;\n");
    expect(button(host, "Revert")).not.toBeUndefined();
  });

  it("saves the draft against the hash the file was read with", async () => {
    setDraft(KEY, { text: "const a = 2;\n", baseHash: HASH_A });
    const host = await mount();

    button(host, "Save")?.click();
    await settle();

    expect(saved).toEqual([{ path: "src/a.ts", content: "const a = 2;\n", expectedHash: HASH_A }]);
    expect(getDraft(KEY)).toBeNull();
  });

  it("leaves Save inert with nothing edited", async () => {
    const host = await mount();
    expect(button(host, "Save")?.disabled).toBe(true);
  });

  it("keeps the edits and explains when a save is refused", async () => {
    setDraft(KEY, { text: "const a = 2;\n", baseHash: HASH_A });
    conflictOnSave = true;
    const host = await mount();

    button(host, "Save")?.click();
    await settle();

    expect(host.textContent).toContain("changed on disk after you opened it");
    expect(getDraft(KEY)?.text).toBe("const a = 2;\n");
  });

  it("throws the draft away on revert", async () => {
    setDraft(KEY, { text: "const a = 2;\n", baseHash: HASH_A });
    const host = await mount();

    button(host, "Revert")?.click();
    await settle();

    expect(getDraft(KEY)).toBeNull();
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe("const a = 1;\n");
  });

  it("describes a binary file rather than opening an editor on it", async () => {
    file = {
      path: "logo.png",
      content: null,
      unreadable: "binary",
      hash: "c".repeat(64),
      size: 42,
    };
    const host = await mount();
    expect(host.textContent).toContain("This is a binary file.");
    expect(host.querySelector('[data-testid="editor"]')).toBeNull();
  });

  it("shows the file it was pointed at, not the one it was showing", async () => {
    filesByPath = {
      "src/a.ts": fileOf("src/a.ts", "AAA\n", HASH_A),
      "src/b.ts": fileOf("src/b.ts", "BBB\n", HASH_B),
    };
    const host = await mountSwitchable();

    await switchTo("src/b.ts");

    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe("BBB\n");
  });

  it("drops a conflict raised on the file it has left", async () => {
    filesByPath = {
      "src/a.ts": fileOf("src/a.ts", "AAA\n", HASH_A),
      "src/b.ts": fileOf("src/b.ts", "BBB\n", HASH_B),
    };
    setDraft(draftKey("ws-1", "wr-1", "src/a.ts"), { text: "MINE\n", baseHash: HASH_A });
    conflictOnSave = true;
    const host = await mountSwitchable();
    button(host, "Save")?.click();
    await settle();
    expect(host.textContent).toContain("changed on disk after you opened it");

    conflictOnSave = false;
    await switchTo("src/b.ts");

    expect(host.textContent).not.toContain("changed on disk after you opened it");
  });

  it("overwrites with the buffer of the file on screen", async () => {
    // The hash guard cannot catch a save that carries another file's *content*:
    // re-reading for the current hash makes such a write look entirely valid.
    filesByPath = {
      "src/a.ts": fileOf("src/a.ts", "AAA\n", HASH_A),
      "src/b.ts": fileOf("src/b.ts", "BBB\n", HASH_B),
    };
    setDraft(draftKey("ws-1", "wr-1", "src/b.ts"), { text: "B EDITED\n", baseHash: HASH_B });
    const host = await mountSwitchable();
    await switchTo("src/b.ts");

    conflictOnSave = true;
    button(host, "Save")?.click();
    await settle();
    conflictOnSave = false;
    [...host.querySelectorAll("button")]
      .find((b) => b.textContent === "Overwrite with mine")
      ?.click();
    await settle();

    expect(saved).toEqual([{ path: "src/b.ts", content: "B EDITED\n", expectedHash: HASH_B }]);
  });

  it("keeps a save from running twice against the same base hash", async () => {
    setDraft(KEY, { text: "const a = 2;\n", baseHash: HASH_A });
    const host = await mountSwitchable();

    button(host, "Save")?.click();
    button(host, "Save")?.click();
    await settle();

    expect(saved.length).toBe(1);
  });

  it("keeps what was typed while the save was in flight", async () => {
    setDraft(KEY, { text: "const a = 2;\n", baseHash: HASH_A });
    const host = await mountSwitchable();

    button(host, "Save")?.click();
    // A keystroke lands before the write returns.
    setDraft(KEY, { text: "const a = 3;\n", baseHash: HASH_A });
    await settle();

    expect(getDraft(KEY)?.text).toBe("const a = 3;\n");
  });

  it("warns when the buffer outlived the tab and the file moved underneath", async () => {
    // The tab was closed with an edit in it; the agent rewrote the file; the tab
    // is reopened. Nothing about a fresh read would refuse the save — its hash
    // matches disk — so the file having moved has to be noticed here.
    setDraft(KEY, { text: "MINE\n", baseHash: HASH_A });
    file = fileOf("src/a.ts", "AGENT WROTE THIS\n", HASH_B);

    const host = await mount();

    expect(host.textContent).toContain("changed on disk after you opened it");
    expect(getDraft(KEY)?.text).toBe("MINE\n");
  });

  it("saves against what the edit started from, not the latest read", async () => {
    setDraft(KEY, { text: "MINE\n", baseHash: HASH_A });
    file = fileOf("src/a.ts", "AGENT WROTE THIS\n", HASH_B);
    const host = await mount();

    button(host, "Save")?.click();
    await settle();

    // HASH_A, so the sidecar refuses it. Sending HASH_B would be accepted and
    // would drop the agent's work with no warning anywhere.
    expect(saved).toEqual([{ path: "src/a.ts", content: "MINE\n", expectedHash: HASH_A }]);
  });

  it("leaves a clean reopened file alone", async () => {
    // No buffer, so a file that changed while the tab was closed is just the
    // file — nothing to warn about.
    file = fileOf("src/a.ts", "AGENT WROTE THIS\n", HASH_B);

    const host = await mount();

    expect(host.textContent).not.toContain("changed on disk after you opened it");
  });

  it("reports a file it could not read", async () => {
    loadError = "load file failed: not found";
    const host = await mount();
    expect(host.textContent).toContain("load file failed: not found");
  });
});
