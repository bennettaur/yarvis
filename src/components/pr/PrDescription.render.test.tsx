import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import * as sidecar from "../../lib/api";
import { prDetailKey } from "../../lib/pr/cache";
import type { PrDetail, PrRef } from "../../lib/pr/types";
import { primeCache } from "../../lib/resourceCache";
import { mountForInteraction, waitFor } from "../../test/render";
import { reviewThread } from "../../test/reviewThread";
import PrDescription from "./PrDescription";

const prRef: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 3 };

/** Writes the page sent; reads of the detail are answered from `current` and counted. */
const paths: string[] = [];
let current: PrDetail;
let detailReads = 0;

// A spy, not `mock.module`, so the stub doesn't outlive this file.
const sidecarFetch = spyOn(sidecar, "sidecarFetch").mockImplementation(async (path: string) => {
  if (path.endsWith("/detail")) {
    detailReads++;
    return new Response(JSON.stringify(current), { status: 200 });
  }
  paths.push(path);
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
});

afterAll(() => {
  sidecarFetch.mockRestore();
});

const detail = (overrides: Partial<PrDetail> = {}): PrDetail => ({
  number: 3,
  title: "Add a thing",
  body: "",
  state: "open",
  draft: false,
  author: "me",
  baseRef: "main",
  headRef: "feat",
  fromFork: false,
  headSha: "",
  additions: 0,
  deletions: 0,
  mergeable: "MERGEABLE",
  hasConflicts: false,
  mergeMethods: [],
  autoMergeEnabled: false,
  canEnableAutoMerge: false,
  canDisableAutoMerge: false,
  checks: [],
  reviewThreads: [],
  reviewers: [],
  ...overrides,
});

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  paths.length = 0;
});

async function mount(d: PrDetail): Promise<HTMLElement> {
  current = d;
  primeCache(prDetailKey(prRef), d);
  const mounted = await mountForInteraction(createElement(PrDescription, { prRef }));
  cleanup = mounted.unmount;
  return mounted.host;
}

const button = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);

describe("PrDescription comments", () => {
  // An outdated thread can't sit beside a line any more, so this list is the
  // only place left to finish the conversation.
  it("lists an outdated thread with its tag and lets it be resolved", async () => {
    const outdated = reviewThread({
      id: "PRRT_9",
      line: null,
      isOutdated: true,
      bodies: ["this moved"],
    });
    const host = await mount(detail({ reviewThreads: [outdated] }));
    expect(host.textContent).toContain("this moved");
    expect(host.textContent).toContain("outdated");

    const readsBefore = detailReads;
    button(host, "Resolve")?.click();
    await waitFor(() => button(host, "Unresolve") !== undefined, "the Unresolve button");
    // Resolving refetches the detail. A refetch not yet sent when the file ends
    // goes to the real client once the spy is restored.
    await waitFor(() => detailReads > readsBefore, "the detail refetch");
    expect(paths).toContain("/api/github/pr/octo/repo/3/threads/PRRT_9/resolve");
  });

  it("says when not every thread could be loaded", async () => {
    const host = await mount(detail({ reviewThreadsTruncated: true }));
    expect(host.textContent).toContain("Not every comment thread could be loaded");
  });

  it("says nothing about missing threads when all of them loaded", async () => {
    const host = await mount(detail());
    expect(host.textContent).not.toContain("Not every comment thread");
  });
});
