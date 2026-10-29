import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { WorkspaceStatus, WorkspaceSummary } from "./workspaces";

let response: Response = new Response("{}", { status: 200 });

// Only the fetch is stubbed; `workspaces.ts` also imports `streamSSE` from here.
const api = await import("./api");
mock.module("./api", () => ({
  ...api,
  sidecarFetch: async () => response,
}));

const { FileConflictError, IDLE_AFTER_DAYS, idleDays, saveWorkspaceRepoFile } = await import(
  "./workspaces"
);

beforeEach(() => {
  response = new Response("{}", { status: 200 });
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

describe("idleDays", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const row = (status: WorkspaceStatus, lastActiveAt: string | null) =>
    ({ status, lastActiveAt }) as WorkspaceSummary;

  it("counts the whole days an active workspace has sat untouched past the threshold", () => {
    expect(idleDays(row("active", "2026-10-19T11:00:00Z"), now)).toBe(10);
    expect(idleDays(row("active", "2026-10-22T12:00:00Z"), now)).toBe(IDLE_AFTER_DAYS);
  });

  it("doesn't mark a recently used workspace", () => {
    expect(idleDays(row("active", "2026-10-22T12:00:01Z"), now)).toBeNull();
  });

  it("only marks active workspaces", () => {
    expect(idleDays(row("archiving", "2026-01-01T00:00:00Z"), now)).toBeNull();
    expect(idleDays(row("archived", null), now)).toBeNull();
  });
});
