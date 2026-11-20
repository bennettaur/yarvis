import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as sidecar from "../api";
import { disableAutoMerge, enableAutoMerge, mergePr, replyToPrThread } from "./api";
import type { PrRef } from "./types";

const azureRef: PrRef = { provider: "azure", org: "acme", project: "Shop", repo: "web", prId: 7 };

const sent: { path: string; body: unknown }[] = [];

// A spy, not `mock.module`, so the stub doesn't outlive this file.
const sidecarFetch = spyOn(sidecar, "sidecarFetch").mockImplementation(
  async (path: string, init?: RequestInit) => {
    sent.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  },
);

afterAll(() => {
  sidecarFetch.mockRestore();
});

describe("replyToPrThread on Azure", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  const comment = (id: string) => ({ id, author: "Rev", body: "hm", createdAt: "" });

  it("names the thread's first comment as the parent", async () => {
    await replyToPrThread(azureRef, { id: "3", comments: [comment("1"), comment("4")] }, "ok");
    expect(sent[0]).toEqual({
      path: "/api/azure/pr/Shop/web/7/threads/3/replies",
      body: { body: "ok", parentCommentId: 1 },
    });
  });

  // A missing id must not become parent 0, which the sidecar refuses.
  it("leaves the parent to the sidecar when the first comment has no id", async () => {
    await replyToPrThread(azureRef, { id: "3", comments: [comment("")] }, "ok");
    expect(sent[0]!.body).toEqual({ body: "ok" });
  });
});

// Merge is GitHub-only; the dispatch must refuse an Azure ref rather than route
// it to a non-existent Azure transport. The UI already hides the buttons for
// Azure, so this guards the boundary in case a caller reaches it directly.
describe("merge dispatch rejects non-github refs", () => {
  it("mergePr throws for an azure ref", () => {
    expect(() => mergePr(azureRef, "MERGE")).toThrow(/only supported for GitHub/);
  });

  it("enableAutoMerge throws for an azure ref", () => {
    expect(() => enableAutoMerge(azureRef, "SQUASH")).toThrow(/only supported for GitHub/);
  });

  it("disableAutoMerge throws for an azure ref", () => {
    expect(() => disableAutoMerge(azureRef)).toThrow(/only supported for GitHub/);
  });
});
