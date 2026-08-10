import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createElement, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import * as api from "../api";
import type { PrRef } from "./types";
import { listViewed, markManyViewed, setViewed, usePrViewedFiles } from "./viewed";

let lastCall: { path: string; init?: RequestInit } | null = null;
/** Every write the lib made, so a test can assert one did not happen. */
let writes = 0;
let nextResponse: () => Response = () => new Response("{}", { status: 200 });

// Stub the sidecar transport so we don't hit Tauri's `invoke` for the bearer
// token / port; tests assert against the path the lib chose to call. A spy
// rather than `mock.module`, which would replace the `../api` namespace for
// every file loaded after this one with no way to put it back — and these
// tests need the real `ensureOk`, so they must not hand a stubbed one on.
const sidecarFetch = spyOn(api, "sidecarFetch").mockImplementation(
  async (path: string, init?: RequestInit) => {
    lastCall = { path, init };
    if (init?.method === "POST") writes++;
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

/**
 * Finishing a guide step marks every file that step covered. One failure among
 * them is reported rather than thrown, so the files that did save stay saved.
 */
describe("markManyViewed", () => {
  beforeEach(() => {
    localStorage.clear();
    nextResponse = () => new Response("{}", { status: 200 });
  });

  it("marks every path and reports no failures", async () => {
    const failed = await markManyViewed(azureRef, ["a.test.ts", "b.test.ts"]);
    expect(failed).toEqual([]);
    const set = await listViewed(azureRef);
    expect(set.has("a.test.ts")).toBe(true);
    expect(set.has("b.test.ts")).toBe(true);
  });

  it("returns the paths that could not be saved instead of throwing", async () => {
    let call = 0;
    nextResponse = () =>
      ++call === 2 ? new Response("nope", { status: 502 }) : new Response("{}");
    const failed = await markManyViewed(githubRef, ["a.ts", "b.ts", "c.ts"]);
    expect(failed).toEqual(["b.ts"]);
  });
});

/**
 * The hook's bulk mark, driven the way a guide step drives it. Worth mounting
 * rather than testing the module function alone: the delta it writes has to be
 * computed outside React's state updater, since an updater does not run until
 * the next render — and a version that read its delta from inside one marked
 * files on screen while persisting nothing.
 */
describe("usePrViewedFiles markAllViewed", () => {
  beforeEach(() => {
    localStorage.clear();
    writes = 0;
    nextResponse = () => new Response("{}", { status: 200 });
  });

  /** Mounts the hook, runs `drive` once, and reports what the UI ended up showing. */
  async function mark(paths: string[], ref: PrRef = azureRef): Promise<Set<string>> {
    let latest = new Set<string>();
    function Harness() {
      const files = usePrViewedFiles(ref);
      latest = files.viewed;
      const driven = useRef(false);
      useEffect(() => {
        if (driven.current || files.loading) return;
        driven.current = true;
        void files.markAllViewed(paths);
      });
      return null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(createElement(Harness));
    await new Promise((r) => setTimeout(r, 60));
    root.unmount();
    host.remove();
    return latest;
  }

  it("persists every path, not only the on-screen set", async () => {
    const shown = await mark(["a.test.ts", "b.test.ts"]);
    expect([...shown].sort()).toEqual(["a.test.ts", "b.test.ts"]);
    // The provider is the real check: a mark the reviewer cannot see again
    // after a reload has not been made.
    expect([...(await listViewed(azureRef))].sort()).toEqual(["a.test.ts", "b.test.ts"]);
  });

  // Marking is add-only, so a file the reviewer already ticked is left alone
  // rather than written again on every step that happens to name it.
  it("writes nothing for a file already marked", async () => {
    nextResponse = () => new Response(JSON.stringify(["a.ts"]), { status: 200 });
    writes = 0;
    const shown = await mark(["a.ts"], githubRef);
    expect(shown.has("a.ts")).toBe(true);
    expect(writes).toBe(0);
  });

  // A file the provider refused is not viewed, and the tick has to come back
  // off rather than telling the reviewer they finished with it.
  it("rolls back a path the provider rejected", async () => {
    nextResponse = () => new Response("nope", { status: 502 });
    const shown = await mark(["a.ts"], githubRef);
    expect(shown.has("a.ts")).toBe(false);
  });
});
