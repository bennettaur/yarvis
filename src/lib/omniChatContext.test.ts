import { afterEach, describe, expect, it } from "bun:test";
import {
  collectContext,
  formatContext,
  type PageContext,
  registerContext,
} from "./omniChatContext";

// Each test cleans up its registrations so the shared module store doesn't leak
// between cases.
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const register = (id: string, build: () => PageContext | null) => {
  cleanups.push(registerContext(id, build));
};

describe("omniChatContext", () => {
  it("collects a snapshot from every registered contributor", () => {
    register("tab", () => ({ source: "tab", summary: "Viewing the PRs tab" }));
    register("prs", () => ({ source: "prs", summary: "Reviewing PR #18" }));

    const got = collectContext().map((c) => c.summary);
    expect(got).toContain("Viewing the PRs tab");
    expect(got).toContain("Reviewing PR #18");
  });

  it("skips contributors that currently have nothing to add", () => {
    register("tab", () => ({ source: "tab", summary: "Viewing the Chat tab" }));
    register("prs", () => null);

    expect(collectContext()).toHaveLength(1);
  });

  it("stops collecting once a contributor is unregistered", () => {
    const off = registerContext("temp", () => ({ source: "temp", summary: "here" }));
    expect(collectContext()).toHaveLength(1);
    off();
    expect(collectContext()).toHaveLength(0);
  });

  it("last registration for an id wins", () => {
    register("prs", () => ({ source: "prs", summary: "first" }));
    register("prs", () => ({ source: "prs", summary: "second" }));
    const got = collectContext();
    expect(got).toHaveLength(1);
    expect(got[0]?.summary).toBe("second");
  });

  it("a stale cleanup does not clobber a newer registration (remount guard)", () => {
    // A remount can re-register before the previous instance's cleanup runs; the
    // stale cleanup must not delete the live builder.
    const offFirst = registerContext("prs", () => ({ source: "prs", summary: "first" }));
    register("prs", () => ({ source: "prs", summary: "second" }));
    offFirst(); // stale cleanup from the unmounted instance
    const got = collectContext();
    expect(got).toHaveLength(1);
    expect(got[0]?.summary).toBe("second");
  });

  it("renders summaries and details, and undefined when empty", () => {
    expect(formatContext([])).toBeUndefined();

    const rendered = formatContext([
      { source: "prs", summary: "Reviewing PR #18", details: { url: "https://x/18" } },
    ]);
    expect(rendered).toContain("[prs] Reviewing PR #18");
    expect(rendered).toContain('"url":"https://x/18"');
  });

  it("omits an empty details object", () => {
    const rendered = formatContext([
      { source: "tab", summary: "Viewing the Chat tab", details: {} },
    ]);
    expect(rendered).toBe("[tab] Viewing the Chat tab");
  });
});
