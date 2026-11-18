import { describe, expect, it } from "bun:test";
import { isFailingCheck } from "./fixChecks";
import type { CheckItem } from "./types";

// The same table as `failingChecks` in sidecar/src/pr/fixChecks.test.ts, so the
// button and what the agent is sent can't drift apart.
const FAILING = ["FAILURE", "failure", "ERROR", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"];
const NOT_FAILING = ["SUCCESS", "SKIPPED", "NEUTRAL", "CANCELLED", "STALE", "PENDING"];

const check = (conclusion: string | null, status = "COMPLETED"): CheckItem => ({
  name: "build",
  status,
  conclusion,
  url: null,
});

describe("isFailingCheck", () => {
  it.each(FAILING)("counts %s as failing", (conclusion) => {
    expect(isFailingCheck(check(conclusion))).toBe(true);
  });

  it.each(NOT_FAILING)("doesn't count %s", (conclusion) => {
    expect(isFailingCheck(check(conclusion))).toBe(false);
  });

  it("doesn't count a check that is still running", () => {
    expect(isFailingCheck(check(null, "IN_PROGRESS"))).toBe(false);
  });
});
