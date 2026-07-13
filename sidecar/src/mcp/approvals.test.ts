import { describe, expect, it } from "bun:test";
import { resolveApproval, waitForApproval } from "./approvals.ts";

describe("approvals", () => {
  it("resolves a waiting approval", async () => {
    const pending = waitForApproval("c1", { timeoutMs: 1000 });
    expect(resolveApproval("c1", true)).toBe(true);
    expect(await pending).toBe(true);
  });

  it("remembers a decision that arrives before the waiter", async () => {
    expect(resolveApproval("c2", true)).toBe(false); // no waiter yet
    expect(await waitForApproval("c2", { timeoutMs: 1000 })).toBe(true);
  });

  it("denies on timeout", async () => {
    expect(await waitForApproval("c3", { timeoutMs: 10 })).toBe(false);
  });

  it("denies when the request is aborted", async () => {
    const controller = new AbortController();
    const pending = waitForApproval("c4", { timeoutMs: 5000, signal: controller.signal });
    controller.abort();
    expect(await pending).toBe(false);
  });
});
