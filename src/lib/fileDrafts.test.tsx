import { beforeEach, describe, expect, it } from "bun:test";
import { renderToHtml } from "../test/render";
import {
  clearDraft,
  draftKey,
  fileKey,
  getDraft,
  resetDrafts,
  setDraft,
  useWorkspaceDraftKeys,
} from "./fileDrafts";

/** Stands in for whatever the file hashed to when the edit began; these tests
 *  are about the keys, not the conflict check. */
const HASH_A = "a".repeat(64);

beforeEach(() => {
  resetDrafts();
});

describe("draftKey", () => {
  it("keeps two files apart that would collide if the parts were concatenated", () => {
    // "a/b" in repo "r" vs "b" in a repo named "r/a": the same characters in the
    // same order, and a different file.
    expect(draftKey("ws", "r", "a/b")).not.toBe(draftKey("ws", "r/a", "b"));
  });
});

describe("drafts", () => {
  it("holds a buffer per file", () => {
    const a = draftKey("ws", "repo", "src/a.ts");
    const b = draftKey("ws", "repo", "src/b.ts");
    setDraft(a, { text: "edited a", baseHash: HASH_A });
    setDraft(b, { text: "edited b", baseHash: HASH_A });

    expect(getDraft(a)?.text).toBe("edited a");
    expect(getDraft(b)?.text).toBe("edited b");
  });

  it("reports no draft for a file that has none", () => {
    expect(getDraft(draftKey("ws", "repo", "src/a.ts"))).toBeNull();
  });

  it("drops a buffer on clear", () => {
    const key = draftKey("ws", "repo", "src/a.ts");
    setDraft(key, { text: "edited", baseHash: HASH_A });
    clearDraft(key);
    expect(getDraft(key)).toBeNull();
  });
});

function DirtyKeys({ workspaceId }: { workspaceId: string }) {
  const keys = useWorkspaceDraftKeys(workspaceId);
  // NULs don't survive a render intact, so the parts are shown separated.
  return (
    <ul>
      {[...keys].map((key) => (
        <li key={key}>{key.split("\u0000").join(" · ")}</li>
      ))}
    </ul>
  );
}

describe("useWorkspaceDraftKeys", () => {
  it("lists this workspace's dirty files by repo and path", async () => {
    setDraft(draftKey("ws-1", "repo-a", "src/a.ts"), { text: "edited", baseHash: HASH_A });
    setDraft(draftKey("ws-1", "repo-b", "README.md"), { text: "edited", baseHash: HASH_A });

    const html = await renderToHtml(<DirtyKeys workspaceId="ws-1" />);

    expect(html).toContain("repo-a · src/a.ts");
    expect(html).toContain("repo-b · README.md");
  });

  it("names a dirty file exactly as a terminal surface names its editor tab", async () => {
    // The tab strip matches `fileKey` against these; if the two ever disagree
    // the dirty marker and the unsaved-close prompt silently stop working.
    setDraft(draftKey("ws-1", "repo-a", "src/a.ts"), { text: "edited", baseHash: HASH_A });

    const html = await renderToHtml(<DirtyKeys workspaceId="ws-1" />);

    expect(html).toContain(fileKey("repo-a", "src/a.ts").split("\u0000").join(" · "));
  });

  it("leaves out buffers belonging to another workspace", async () => {
    setDraft(draftKey("ws-2", "repo-a", "src/other.ts"), { text: "edited", baseHash: HASH_A });

    const html = await renderToHtml(<DirtyKeys workspaceId="ws-1" />);

    expect(html).not.toContain("src/other.ts");
  });
});
