import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSidecarApi, stubSidecarApi } from "../test/sidecarApi";

let response: Response = new Response("{}", { status: 200 });
let requested: string[] = [];

stubSidecarApi({
  sidecarFetch: async (path: string) => {
    requested.push(path);
    return response.clone();
  },
});

const { FileConflictError, getWorkspace, listWorkspaces, saveWorkspaceRepoFile } = await import(
  "./workspaces"
);

beforeEach(() => {
  response = new Response("{}", { status: 200 });
  requested = [];
});

describe("telling the sidecar's PR poller what's on screen", () => {
  const realHasFocus = document.hasFocus.bind(document);
  afterAll(() => {
    document.hasFocus = realHasFocus;
  });

  it("flags the list's badges and the open workspace while the window has focus", async () => {
    document.hasFocus = () => true;
    response = new Response("[]", { status: 200 });
    await listWorkspaces({ showingBadges: true });
    await getWorkspace("ws-1", { viewing: true });
    expect(requested).toEqual(["/api/workspaces?badges=1", "/api/workspaces/ws-1?viewing=1"]);
  });

  it("flags nothing while the window is in the background", async () => {
    document.hasFocus = () => false;
    response = new Response("[]", { status: 200 });
    await listWorkspaces({ showingBadges: true });
    await getWorkspace("ws-1", { viewing: true });
    expect(requested).toEqual(["/api/workspaces", "/api/workspaces/ws-1"]);
  });

  it("flags nothing while the window has focus but is hidden", async () => {
    document.hasFocus = () => true;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      response = new Response("[]", { status: 200 });
      await listWorkspaces({ showingBadges: true });
      await getWorkspace("ws-1", { viewing: true });
      expect(requested).toEqual(["/api/workspaces", "/api/workspaces/ws-1"]);
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it("flags nothing for a read that isn't the Workspaces view", async () => {
    document.hasFocus = () => true;
    response = new Response("[]", { status: 200 });
    await listWorkspaces();
    await getWorkspace("ws-1");
    expect(requested).toEqual(["/api/workspaces", "/api/workspaces/ws-1"]);
  });
});

describe("saveWorkspaceRepoFile", () => {
  it("reads a refused save as a conflict rather than a generic failure", async () => {
    // The editor's recovery banner hangs off this type. A plain Error here means
    // the user is shown a raw message with no way out of the conflict.
    response = new Response(JSON.stringify({ error: "file changed on disk" }), { status: 409 });

    await expect(
      saveWorkspaceRepoFile("ws-1", "wr-1", "src/a.ts", "edited", "a".repeat(64)),
    ).rejects.toBeInstanceOf(FileConflictError);
  });

  it("reports any other failure as an ordinary error", async () => {
    response = new Response(JSON.stringify({ error: "path must not be inside .git" }), {
      status: 400,
    });

    await expect(
      saveWorkspaceRepoFile("ws-1", "wr-1", ".git", "edited", "a".repeat(64)),
    ).rejects.toThrow("path must not be inside .git");
  });

  it("returns the hash the file now has", async () => {
    response = new Response(JSON.stringify({ hash: "b".repeat(64), size: 6 }), { status: 200 });

    const result = await saveWorkspaceRepoFile(
      "ws-1",
      "wr-1",
      "src/a.ts",
      "edited",
      "a".repeat(64),
    );

    expect(result).toEqual({ hash: "b".repeat(64), size: 6 });
  });
});

afterAll(resetSidecarApi);
