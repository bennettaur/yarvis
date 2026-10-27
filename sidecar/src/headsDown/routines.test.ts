import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dueRoutines, loadRoutines, parseEvery, parseRoutine, type Routine } from "./routines.ts";

const file = (frontmatter: string, body = "Do the thing.") =>
  `---\n${frontmatter}\n---\n\n${body}\n`;

function routine(name: string, everyMinutes: number, extra: Partial<Routine> = {}): Routine {
  return {
    name,
    description: name,
    prompt: "Do the thing.",
    everyMinutes,
    workingHoursOnly: false,
    enabled: true,
    source: "user",
    path: `${name}.md`,
    ...extra,
  };
}

describe("parseEvery", () => {
  it("reads minutes, hours and days", () => {
    expect(parseEvery("30m")).toBe(30);
    expect(parseEvery("3h")).toBe(180);
    expect(parseEvery(" 1D ")).toBe(24 * 60);
  });

  it("refuses anything else", () => {
    expect(parseEvery("3 hours")).toBeNull();
    expect(parseEvery("1.5h")).toBeNull();
    expect(parseEvery("")).toBeNull();
  });
});

describe("parseRoutine", () => {
  it("reads a routine", () => {
    const parsed = parseRoutine(
      "standup.md",
      file("name: standup\ndescription: Prepares standup notes\nevery: 1d\nworkingHours: yes"),
      "user",
    );
    expect(parsed).toMatchObject({
      name: "standup",
      everyMinutes: 24 * 60,
      workingHoursOnly: true,
      enabled: true,
      prompt: "Do the thing.",
    });
  });

  it("rejects an unknown key, a missing cadence, one too short, and an empty body", () => {
    const base = "name: x\ndescription: y";
    expect(() => parseRoutine("a.md", file(`${base}\nevery: 1h\ntools: a`), "user")).toThrow(
      "unknown key(s): tools",
    );
    expect(() => parseRoutine("a.md", file(base), "user")).toThrow("'every' is required");
    expect(() => parseRoutine("a.md", file(`${base}\nevery: 5m`), "user")).toThrow(
      "cannot be shorter than 15m",
    );
    expect(() => parseRoutine("a.md", file(`${base}\nevery: 1h`, ""), "user")).toThrow(
      "cannot be empty",
    );
  });
});

describe("loadRoutines", () => {
  let dir: string;
  const original = process.env.YARVIS_ROUTINES_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "routines-"));
    process.env.YARVIS_ROUTINES_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env.YARVIS_ROUTINES_DIR = original;
  });

  it("loads the shipped routines when the user has none", async () => {
    const { routines, problems } = await loadRoutines();
    expect(problems).toEqual([]);
    expect(routines.map((r) => [r.name, r.enabled])).toEqual([
      ["meeting-alarms", true],
      ["meeting-notes", false],
    ]);
  });

  it("lets a user file replace a shipped one, and reports a broken file", async () => {
    writeFileSync(
      join(dir, "meeting-alarms.md"),
      file("name: meeting-alarms\ndescription: mine\nevery: 1h\nenabled: false"),
    );
    writeFileSync(join(dir, "broken.md"), "no frontmatter");
    mkdirSync(join(dir, "folder.md"));

    const { routines, problems } = await loadRoutines();
    expect(routines.find((r) => r.name === "meeting-alarms")).toMatchObject({
      source: "user",
      enabled: false,
      everyMinutes: 60,
    });
    expect(problems.map((p) => p.path)).toEqual([join(dir, "broken.md")]);
  });
});

describe("dueRoutines", () => {
  const now = new Date("2026-10-27T15:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60_000);
  const base = { now, withinWorkingHours: true, limit: 5 };

  it("offers a routine once its cadence has passed since it was last done", () => {
    const routines = [routine("hourly", 60), routine("daily", 24 * 60), routine("fresh", 60)];
    const lastDone = new Map([
      ["hourly", hoursAgo(2)],
      ["daily", hoursAgo(3)],
    ]);
    expect(dueRoutines({ ...base, routines, lastDone }).map((r) => r.name)).toEqual([
      "fresh",
      "hourly",
    ]);
  });

  it("keeps to the limit, most overdue against its own cadence first", () => {
    const routines = [routine("hourly", 60), routine("daily", 24 * 60)];
    const lastDone = new Map([
      ["hourly", hoursAgo(1.5)],
      ["daily", hoursAgo(48)],
    ]);
    expect(dueRoutines({ ...base, routines, lastDone, limit: 1 }).map((r) => r.name)).toEqual([
      "daily",
    ]);
    expect(dueRoutines({ ...base, routines, lastDone, limit: 0 })).toEqual([]);
  });

  it("leaves out a turned-off routine, and a working-hours one outside them", () => {
    const routines = [
      routine("off", 60, { enabled: false }),
      routine("office", 60, { workingHoursOnly: true }),
    ];
    const lastDone = new Map<string, Date>();
    expect(dueRoutines({ ...base, routines, lastDone }).map((r) => r.name)).toEqual(["office"]);
    expect(dueRoutines({ ...base, routines, lastDone, withinWorkingHours: false })).toEqual([]);
  });
});
