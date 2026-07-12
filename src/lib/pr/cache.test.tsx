import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

// The cache module reads these from ./api at import time; stub the detail
// loader so we control what each (re)fetch resolves to without hitting a
// provider transport.
let draft = true;
let fetchCount = 0;
mock.module("./api", () => ({
  fetchPrDetail: async () => {
    fetchCount++;
    return { draft };
  },
  fetchPrFiles: async () => [],
  fetchPrStatus: async () => ({}),
  fetchPrFileDiff: async (_ref: unknown, file: unknown) => file,
}));

import { invalidate, prDetailKey, usePrDetail } from "./cache";
import type { PrRef } from "./types";

const ref: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 7 };

function Probe() {
  const { data } = usePrDetail(ref);
  return createElement("span", null, data ? (data.draft ? "draft" : "open") : "loading");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("cache invalidation", () => {
  it("refetches a mounted subscriber when its key is invalidated", async () => {
    draft = true;
    fetchCount = 0;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    root.render(createElement(Probe));
    await settle();
    expect(host.textContent).toBe("draft");
    expect(fetchCount).toBe(1);

    // Simulate the "Ready for review" write: the PR is now open, and the write
    // handler invalidates the cached detail. The mounted probe must refetch and
    // flip to "open" without remounting.
    draft = false;
    invalidate(prDetailKey(ref));
    await settle();
    expect(host.textContent).toBe("open");
    expect(fetchCount).toBe(2);

    root.unmount();
    host.remove();
  });
});
