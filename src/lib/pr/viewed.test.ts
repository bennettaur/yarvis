import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as api from "../api";
import type { PrRef } from "./types";
import { listViewed, setViewed } from "./viewed";

let lastCall: { path: string; init?: RequestInit } | null = null;
let nextResponse: () => Response = () => new Response("{}", { status: 200 });

// Stub the sidecar transport so we don't hit Tauri's `invoke` for the bearer
// token / port; tests assert against the path the lib chose to call. A spy
// rather than `mock.module`, which would replace the `../api` namespace for
// every file loaded after this one with no way to put it back — and these
// tests need the real `ensureOk`, so they must not hand a stubbed one on.
const sidecarFetch = spyOn(api, "sidecarFetch").mockImplementation(
  async (path: string, init?: RequestInit) => {
    lastCall = { path, init };
    return nextResponse();
  },
);

afterAll(() => {
  sidecarFetch.mockRestore();
});

const azureRef: PrRef = {
  provider: "azure",
  org: "acme",
  project: "Shop",
  repo: "web",
  prId: 42,
};

const githubRef: PrRef = {
  provider: "github",
  owner: "octo",
  repo: "repo",
  number: 7,
};

describe("viewed (azure localStorage path)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns an empty set when nothing has been marked", async () => {
    const set = await listViewed(azureRef);
    expect(set.size).toBe(0);
  });

  it("persists a viewed path and reads it back", async () => {
    await setViewed(azureRef, "src/app.ts", true);
    const set = await listViewed(azureRef);
    expect(set.has("src/app.ts")).toBe(true);
    expect(set.size).toBe(1);
  });

  it("removes a path when viewed=false", async () => {
    await setViewed(azureRef, "a.ts", true);
    await setViewed(azureRef, "b.ts", true);
    await setViewed(azureRef, "a.ts", false);
    const set = await listViewed(azureRef);
    expect(set.has("a.ts")).toBe(false);
    expect(set.has("b.ts")).toBe(true);
  });

  it("isolates state across different Azure PRs", async () => {
    await setViewed(azureRef, "x.ts", true);
    const otherPr: PrRef = { ...azureRef, prId: 99 };
    const set = await listViewed(otherPr);
    expect(set.size).toBe(0);
  });
});

describe("viewed (github fetch path)", () => {
  beforeEach(() => {
    lastCall = null;
    nextResponse = () => new Response("{}", { status: 200 });
  });

  it("fetches the list of viewed paths from the sidecar", async () => {
    nextResponse = () => new Response(JSON.stringify(["src/a.ts", "src/b.ts"]), { status: 200 });
    const set = await listViewed(githubRef);
    expect(lastCall?.path).toContain("/api/github/pr/octo/repo/7/viewed");
    expect(set.has("src/a.ts")).toBe(true);
    expect(set.has("src/b.ts")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("posts the path + viewed flag when toggling", async () => {
    nextResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    await setViewed(githubRef, "src/app.ts", true);
    expect(lastCall?.path).toContain("/api/github/pr/octo/repo/7/viewed");
    expect(lastCall?.init?.method).toBe("POST");
    const parsed = JSON.parse(String(lastCall?.init?.body ?? "")) as {
      path: string;
      viewed: boolean;
    };
    expect(parsed.path).toBe("src/app.ts");
    expect(parsed.viewed).toBe(true);
  });

  it("throws when the sidecar rejects the write — surfaces the failure for the caller to roll back", async () => {
    nextResponse = () => new Response("nope", { status: 502 });
    await expect(setViewed(githubRef, "src/app.ts", true)).rejects.toThrow(/502/);
  });
});
