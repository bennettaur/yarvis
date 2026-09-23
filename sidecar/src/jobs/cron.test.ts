import { describe, expect, it } from "bun:test";
import { isCronDue, isValidCron, nextCronRun, parseCron } from "./cron.ts";

describe("cron expressions", () => {
  it("accepts a five-field expression", () => {
    expect(isValidCron("45 8 * * 1-5")).toBe(true);
  });

  it("rejects nonsense", () => {
    expect(isValidCron("every tuesday")).toBe(false);
    expect(isValidCron("")).toBe(false);
  });

  it("reports why an expression won't compile", () => {
    const parsed = parseCron("99 * * * *");
    expect("problem" in parsed).toBe(true);
  });

  it("finds the next firing after a given instant", () => {
    const next = nextCronRun("0 9 * * *", new Date("2026-03-04T08:00:00"));
    expect(next?.getHours()).toBe(9);
    expect(next?.getDate()).toBe(4);
  });

  it("has no next firing for an invalid expression", () => {
    expect(nextCronRun("nope", new Date())).toBeNull();
  });
});

describe("whether a cron job is due", () => {
  const every_9am = "0 9 * * *";

  it("waits for the next scheduled time when the job has never run", () => {
    expect(isCronDue(every_9am, null, new Date("2026-03-04T09:00:00"))).toBe(false);
  });

  it("is due once the scheduled time has passed since the last run", () => {
    const last = new Date("2026-03-03T09:00:00");
    expect(isCronDue(every_9am, last, new Date("2026-03-04T09:00:30"))).toBe(true);
  });

  it("is not due again within the same firing", () => {
    const last = new Date("2026-03-04T09:00:00");
    expect(isCronDue(every_9am, last, new Date("2026-03-04T15:00:00"))).toBe(false);
  });

  it("fires late rather than skipping a firing the machine slept through", () => {
    const last = new Date("2026-03-03T09:00:00");
    // Woke at 14:00, hours after the 09:00 firing.
    expect(isCronDue(every_9am, last, new Date("2026-03-04T14:00:00"))).toBe(true);
  });

  it("is never due on an expression that no longer parses", () => {
    expect(isCronDue("nope", new Date("2020-01-01T00:00:00"), new Date())).toBe(false);
  });
});
