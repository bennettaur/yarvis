import { describe, expect, it } from "bun:test";
import type { CheckItem } from "../../lib/pr/types";
import { checkLine, checksClipboardText } from "./PrChecks";

const check = (over: Partial<CheckItem> = {}): CheckItem => ({
  name: "build",
  status: "COMPLETED",
  conclusion: "SUCCESS",
  url: "https://github.com/octo/web/runs/1",
  ...over,
});

describe("checkLine", () => {
  it("reads outcome, name, then link", () => {
    expect(checkLine(check())).toBe("✓ build (success) https://github.com/octo/web/runs/1");
  });

  it("falls back to the status while a check is still running", () => {
    expect(checkLine(check({ status: "IN_PROGRESS", conclusion: null, url: null }))).toBe(
      "○ build (in_progress)",
    );
  });

  // A check name is whatever the workflow calls itself, so a newline in one
  // would otherwise forge a line of its own in the block below.
  it("keeps a hostile check name to one line", () => {
    expect(checkLine(check({ name: "build\n✓ deploy (success)", url: null }))).toBe(
      "✓ build✓ deploy (success) (success)",
    );
  });

  // The copy hands the link to someone else, so it holds to the same scheme
  // allowlist as opening it would.
  it("drops a link openExternal would refuse", () => {
    expect(checkLine(check({ url: "javascript:alert(1)" }))).toBe("✓ build (success)");
  });
});

describe("checksClipboardText", () => {
  it("puts one check per line", () => {
    expect(
      checksClipboardText([
        check({ name: "build", url: null }),
        check({ name: "lint", conclusion: "FAILURE", url: null }),
      ]),
    ).toBe("✓ build (success)\n✕ lint (failure)");
  });
});
