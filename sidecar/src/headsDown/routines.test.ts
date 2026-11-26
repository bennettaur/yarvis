import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteRoutineFile,
  dueRoutines,
  loadRoutines,
  parseEvery,
  parseRoutine,
  type Routine,
  reloadRoutines,
  removeFinishedOnceRoutines,
  resolveRoutineTools,
  routineCatalog,
  routineSchedules,
  setRoutineEnabled,
  writeRoutineFile,
} from "./routines.ts";

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
    tools: [],
    config: {},
    nightShift: "run",
    once: false,
    source: "user",
    path: `/routines/${name}.md`,
    addedAt: null,
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
    expect(() => parseRoutine("a.md", file(`${base}\nevery: 1h\ntool: a`), "user")).toThrow(
      "unknown key(s): tool",
    );
    expect(() => parseRoutine("a.md", file(base), "user")).toThrow("'every' is required");
    expect(() => parseRoutine("a.md", file(`${base}\nevery: soon`), "user")).toThrow(
      "must be a duration",
    );
    expect(() => parseRoutine("a.md", file(`${base}\nevery: 5m`), "user")).toThrow(
      "cannot be shorter than 15m",
    );
    expect(() => parseRoutine("a.md", file(`${base}\nevery: 31d`), "user")).toThrow(
      "cannot be longer than 30d",
    );
    expect(parseRoutine("a.md", file(`${base}\nevery: 30d`), "user").everyMinutes).toBe(
      30 * 24 * 60,
    );
    expect(() => parseRoutine("a.md", file(`${base}\nevery: 1h`, ""), "user")).toThrow(
      "cannot be empty",
    );
    expect(() =>
      parseRoutine("a.md", file(`${base}\nevery: 1h`, "x".repeat(4001)), "user"),
    ).toThrow("cannot be longer than 4000");
  });

  it("rejects a name that can't be a heading in the prompt or a name finish_pass reports", () => {
    for (const name of ["Meeting Alarms", "meeting alarms", "a".repeat(65)]) {
      expect(() =>
        parseRoutine("a.md", file(`name: ${name}\ndescription: y\nevery: 1h`), "user"),
      ).toThrow("lowercase letters, digits and hyphens");
    }
    expect(
      parseRoutine("a.md", file(`name: ${"a".repeat(64)}\ndescription: y\nevery: 1h`), "user").name,
    ).toHaveLength(64);
  });
});

describe("a routine's tools and config", () => {
  const base = "name: slack-watch\ndescription: Watches Slack\nevery: 1h";

  it("reads the tools it names and a flat config map, as text", () => {
    const parsed = parseRoutine(
      "a.md",
      file(
        `${base}\ntools: [slack_read_channel, "mcp:0000:post", slack_read_channel]\nconfig:\n  channels: [eng, "#ops", 42]\n  handle: "@me"\n  maxPerRun: 3\n  quiet: false`,
      ),
      "user",
    );
    expect(parsed.tools).toEqual(["slack_read_channel", "mcp:0000:post"]);
    expect(parsed.config).toEqual({
      channels: ["eng", "#ops", "42"],
      handle: "@me",
      maxPerRun: "3",
      quiet: "false",
    });
  });

  it("defaults both to empty, and takes a comma-separated tool list", () => {
    expect(parseRoutine("a.md", file(base), "user")).toMatchObject({ tools: [], config: {} });
    expect(parseRoutine("a.md", file(`${base}\ntools: a, b`), "user").tools).toEqual(["a", "b"]);
  });

  it("refuses a nested config, a bad key, a tool name with spaces, and too much of either", () => {
    const bad = (extra: string) => () => parseRoutine("a.md", file(`${base}\n${extra}`), "user");
    expect(bad("config: eng")).toThrow("'config' must be a map");
    expect(bad("config:\n  slack:\n    channel: eng")).toThrow(
      "'config.slack' must be text or a list of text",
    );
    expect(bad("config:\n  list: [[a]]")).toThrow("'config.list' item 1 must be text");
    expect(bad("config:\n  1st: a")).toThrow("must start with a letter");
    expect(bad("tools: [post message]")).toThrow("with no spaces: post message");
    expect(bad(`tools: [${Array.from({ length: 21 }, (_, i) => `t${i}`).join(", ")}]`)).toThrow(
      "at most 20 tools",
    );
    expect(bad(`config:\n  long: ${"x".repeat(2001)}`)).toThrow("cannot be longer than 2000");
    const keys = Array.from({ length: 21 }, (_, i) => `  k${i}: v`).join("\n");
    expect(bad(`config:\n${keys}`)).toThrow("at most 20 keys");
  });
});

describe("resolveRoutineTools", () => {
  const registry = [
    { id: "builtin:list_events", name: "list_events", policy: "always" },
    { id: "mcp:s1:post_message", name: "post_message", policy: "search" },
    { id: "mcp:s2:post_message", name: "post_message", policy: "search" },
    { id: "mcp:s1:delete_channel", name: "delete_channel", policy: "disabled" },
    { id: "builtin:remember", name: "remember", policy: "always" },
  ] as const;

  it("matches a name or an id, and says why the rest didn't match", () => {
    const resolved = resolveRoutineTools(
      [
        routine("watch", 60, {
          tools: ["post_message", "builtin:list_events", "delete_channel", "nope", "remember"],
        }),
        routine("plain", 60),
        routine("again", 60, { tools: ["mcp:s1:post_message", "list_events"] }),
      ],
      registry,
      new Set(["builtin:remember"]),
    );
    expect(resolved.ids).toEqual(["builtin:list_events", "mcp:s1:post_message"]);
    expect(resolved.byRoutine.get("watch")).toEqual([
      {
        tool: "post_message",
        matchedIds: [],
        problem:
          "2 tools have that name; name one by its id: mcp:s1:post_message, mcp:s2:post_message",
      },
      { tool: "builtin:list_events", matchedIds: ["builtin:list_events"], problem: null },
      { tool: "delete_channel", matchedIds: [], problem: "turned off in the Tool manager" },
      { tool: "nope", matchedIds: [], problem: "no tool by that name is installed" },
      { tool: "remember", matchedIds: [], problem: "not available in heads-down mode" },
    ]);
    expect(resolved.byRoutine.get("again")?.map((m) => m.matchedIds)).toEqual([
      ["mcp:s1:post_message"],
      ["builtin:list_events"],
    ]);
    expect(resolved.byRoutine.has("plain")).toBe(false);
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
      ["email-drafts", false],
      ["generation-reflection", false],
      ["meeting-alarms", true],
      ["meeting-notes", false],
      ["meeting-times", false],
      ["message-people", false],
      ["offer-help", false],
      ["review-prep", false],
      ["review-reflection", false],
      ["slack-watcher", false],
    ]);
    // A template: the user's own file names their Slack tools and fills these in.
    expect(routines.find((r) => r.name === "slack-watcher")).toMatchObject({
      tools: [],
      config: { channels: [], handle: "" },
    });
  });

  it("lets a user file replace a shipped one, and reports a broken file", async () => {
    writeFileSync(
      join(dir, "meeting-alarms.md"),
      file("name: meeting-alarms\ndescription: mine\nevery: 1h\nenabled: false"),
    );
    writeFileSync(join(dir, "broken.md"), "no frontmatter");
    mkdirSync(join(dir, "folder.md"));
    // A FIFO would block a plain read forever, and every pass with it.
    execFileSync("mkfifo", [join(dir, "pipe.md")]);
    // A link could point into a repo, which routines are never read from.
    const elsewhere = mkdtempSync(join(tmpdir(), "routines-elsewhere-"));
    writeFileSync(join(elsewhere, "linked.md"), file("name: linked\ndescription: y\nevery: 1h"));
    symlinkSync(join(elsewhere, "linked.md"), join(dir, "linked.md"));
    // Exactly at the cap is read (and fails as a routine); one byte past it isn't read at all.
    writeFileSync(join(dir, "edge.md"), "x".repeat(256 * 1024));
    writeFileSync(join(dir, "huge.md"), "x".repeat(256 * 1024 + 1));

    const { routines, problems } = await loadRoutines();
    rmSync(elsewhere, { recursive: true, force: true });
    expect(routines.find((r) => r.name === "meeting-alarms")).toMatchObject({
      source: "user",
      enabled: false,
      everyMinutes: 60,
    });
    expect(routines.map((r) => r.name)).not.toContain("linked");
    expect(problems.map((p) => [p.path, p.message])).toEqual([
      [join(dir, "broken.md"), expect.any(String)],
      [join(dir, "edge.md"), expect.not.stringContaining("larger than")],
      [join(dir, "huge.md"), expect.stringContaining("larger than 256 KB")],
      [join(dir, "linked.md"), expect.stringContaining("a symlink")],
      [join(dir, "pipe.md"), expect.stringContaining("not a regular file")],
    ]);
  });

  it("loads one of two files with the same name, and reports the other", async () => {
    writeFileSync(join(dir, "a.md"), file("name: standup\ndescription: first\nevery: 1d"));
    writeFileSync(join(dir, "b.md"), file("name: standup\ndescription: second\nevery: 1d"));
    const { routines, problems } = await loadRoutines();
    expect(routines.find((r) => r.name === "standup")?.description).toBe("first");
    expect(problems).toEqual([
      { path: join(dir, "b.md"), message: expect.stringContaining("already defines 'standup'") },
    ]);
  });

  it("refuses a routines folder that is a symlink", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "routines-elsewhere-"));
    writeFileSync(join(elsewhere, "linked.md"), file("name: linked\ndescription: y\nevery: 1h"));
    const link = join(dir, "linked-dir");
    symlinkSync(elsewhere, link);
    process.env.YARVIS_ROUTINES_DIR = link;
    try {
      const { routines, problems } = await loadRoutines();
      expect(routines.map((r) => r.name)).not.toContain("linked");
      expect(problems).toEqual([{ path: link, message: expect.stringContaining("a symlink") }]);
    } finally {
      process.env.YARVIS_ROUTINES_DIR = dir;
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  // Root reads a file whatever its mode, so there is nothing unreadable to test.
  it.skipIf(process.getuid?.() === 0)(
    "reports a file it can't read with the reason, not as a symlink",
    async () => {
      writeFileSync(join(dir, "locked.md"), "x");
      chmodSync(join(dir, "locked.md"), 0o000);
      const { problems } = await loadRoutines();
      expect(problems).toEqual([
        { path: join(dir, "locked.md"), message: expect.stringContaining("EACCES") },
      ]);

      // A folder that can't be listed is reported too, not taken as empty.
      chmodSync(dir, 0o000);
      try {
        expect((await loadRoutines()).problems).toEqual([
          { path: dir, message: expect.stringContaining("EACCES") },
        ]);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );
});

describe("dueRoutines", () => {
  const now = new Date("2026-10-27T15:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60_000);
  const base = { now, withinWorkingHours: true, limit: 5, lastOffered: new Map<string, Date>() };

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

  it("counts a routine due at exactly its cadence, and breaks a tie between never-done ones by name", () => {
    const routines = [routine("zeta", 60), routine("alpha", 60), routine("hourly", 60)];
    const lastDone = new Map([["hourly", hoursAgo(1)]]);
    expect(dueRoutines({ ...base, routines, lastDone }).map((r) => r.name)).toEqual([
      "alpha",
      "zeta",
      "hourly",
    ]);
    expect(dueRoutines({ ...base, routines, lastDone, limit: 1 }).map((r) => r.name)).toEqual([
      "alpha",
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

  it("waits before giving a pass a routine an earlier one was given and didn't finish", () => {
    const routines = [routine("flaky", 3 * 60), routine("quick", 30)];
    const lastDone = new Map([
      ["flaky", hoursAgo(10)],
      ["quick", hoursAgo(5)],
    ]);
    const due = (lastOffered: Map<string, Date>) =>
      dueRoutines({ ...base, routines, lastDone, lastOffered }).map((r) => r.name);

    // Given 30 minutes ago and not done: an hour for flaky, its own 30m for quick.
    expect(
      due(
        new Map([
          ["flaky", hoursAgo(0.5)],
          ["quick", hoursAgo(0.5)],
        ]),
      ),
    ).toEqual(["quick"]);
    expect(due(new Map([["flaky", hoursAgo(1)]]))).toEqual(["quick", "flaky"]);
    // Given and done in the same pass is not a failure to retry.
    expect(
      dueRoutines({
        ...base,
        routines,
        lastDone: new Map([["flaky", hoursAgo(4)]]),
        lastOffered: new Map([["flaky", hoursAgo(4)]]),
      }).map((r) => r.name),
    ).toEqual(["quick", "flaky"]);
  });
});

describe("nightShift in a routine", () => {
  const parse = (frontmatter: string) =>
    parseRoutine("x.md", file(`name: x\ndescription: x\nevery: 1h\n${frontmatter}`), "user");

  it("runs at night unless the file says otherwise", () => {
    expect(parse("").nightShift).toBe("run");
    expect(parse("nightShift: slow").nightShift).toBe("slow");
    expect(parse("nightShift: skip").nightShift).toBe("skip");
  });

  it("refuses a value it doesn't know", () => {
    expect(() => parse("nightShift: never")).toThrow("'nightShift' must be run, slow or skip");
  });
});

describe("dueRoutines at night", () => {
  const now = new Date("2026-10-27T03:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60_000);
  const routines = [
    routine("runs", 60),
    routine("slows", 60, { nightShift: "slow" }),
    routine("skips", 60, { nightShift: "skip" }),
  ];
  const input = {
    routines,
    now,
    withinWorkingHours: true,
    limit: 5,
    lastOffered: new Map<string, Date>(),
  };

  it("holds a skip routine and stretches a slow one's cadence", () => {
    const lastDone = new Map(routines.map((r) => [r.name, hoursAgo(2)]));
    const names = (nightShift: boolean) =>
      dueRoutines({ ...input, lastDone, duringNightShift: nightShift }).map((r) => r.name);
    expect(names(false)).toEqual(["runs", "skips", "slows"]);
    expect(names(true)).toEqual(["runs"]);
    const longAgo = new Map(routines.map((r) => [r.name, hoursAgo(4)]));
    expect(
      dueRoutines({ ...input, lastDone: longAgo, duringNightShift: true }).map((r) => r.name),
    ).toEqual(["runs", "slows"]);
  });
});

describe("writeRoutineFile", () => {
  let dir: string;
  const original = process.env.YARVIS_ROUTINES_DIR;

  beforeEach(async () => {
    dir = join(mkdtempSync(join(tmpdir(), "routines-write-")), "routines");
    process.env.YARVIS_ROUTINES_DIR = dir;
    await reloadRoutines();
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    process.env.YARVIS_ROUTINES_DIR = original;
    await reloadRoutines();
  });

  const standup = {
    name: "standup-notes",
    description: "Drafts my standup: what I merged, reviewed and commented on.",
    every: "1d",
    workingHours: true,
    nightShift: "skip" as const,
    body: "Leave a three-line summary in your notes.",
  };

  it("writes a file the loader reads back, and the catalogue has it straight away", async () => {
    const written = await writeRoutineFile(standup);
    expect(written).toEqual({ path: join(dir, "standup-notes.md") });
    const loaded = (await routineCatalog()).routines.find((r) => r.name === "standup-notes");
    expect(loaded).toMatchObject({
      description: standup.description,
      everyMinutes: 24 * 60,
      workingHoursOnly: true,
      nightShift: "skip",
      source: "user",
      prompt: expect.stringContaining("three-line summary"),
    });
  });

  it("refuses a name already in use rather than replacing that routine", async () => {
    expect(await writeRoutineFile({ ...standup, name: "meeting-alarms" })).toEqual({
      error: "a routine named 'meeting-alarms' already exists",
    });
    await writeRoutineFile(standup);
    expect(await writeRoutineFile(standup)).toEqual({
      error: "a routine named 'standup-notes' already exists",
    });
  });

  it("refuses what the loader would refuse, and writes nothing", async () => {
    const result = await writeRoutineFile({ ...standup, every: "5m" });
    expect(result).toEqual({ error: expect.stringContaining("'every' cannot be shorter") });
    expect((await loadRoutines()).routines.some((r) => r.name === "standup-notes")).toBe(false);
  });

  it("refuses to write through a symlinked folder", async () => {
    const target = mkdtempSync(join(tmpdir(), "routines-target-"));
    symlinkSync(target, dir);
    expect(await writeRoutineFile(standup)).toEqual({ error: `${dir} is a symlink` });
    rmSync(target, { recursive: true, force: true });
  });
});

describe("one-off routines", () => {
  const now = new Date("2026-10-27T15:00:00Z");
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  const base = { now, withinWorkingHours: true, limit: 5, lastOffered: new Map<string, Date>() };

  it("needs no cadence, and is read as a one-off", () => {
    const parsed = parseRoutine(
      "x.md",
      file("name: check-ci\ndescription: Check CI\nonce: true"),
      "user",
    );
    expect(parsed).toMatchObject({ once: true, everyMinutes: 60 });
    expect(() =>
      parseRoutine("x.md", file("name: check-ci\ndescription: Check CI"), "user"),
    ).toThrow("'every' is required");
  });

  it("is due until a pass that started after its file was written reports it done", () => {
    const fresh = routine("check-ci", 60, { once: true, addedAt: minutesAgo(10) });
    // Done by a pass under the same name before this file was written: still due.
    const old = new Map([["check-ci", minutesAgo(30)]]);
    expect(dueRoutines({ ...base, routines: [fresh], lastDone: old }).map((r) => r.name)).toEqual([
      "check-ci",
    ]);
    const done = new Map([["check-ci", minutesAgo(5)]]);
    expect(dueRoutines({ ...base, routines: [fresh], lastDone: done })).toEqual([]);
  });
});

describe("routineSchedules", () => {
  const now = new Date("2026-10-27T15:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60_000);
  const base = { now, withinWorkingHours: false, limit: 1, lastOffered: new Map<string, Date>() };

  it("says what the next pass takes, what waits for room, and why the rest wait", () => {
    const routines = [
      routine("a-overdue", 60),
      routine("b-overdue", 60),
      routine("hourly", 60),
      routine("office", 60, { workingHoursOnly: true }),
      routine("off", 60, { enabled: false }),
    ];
    const lastDone = new Map([
      ["a-overdue", hoursAgo(3)],
      ["b-overdue", hoursAgo(2)],
      ["hourly", hoursAgo(0.5)],
    ]);
    const schedules = routineSchedules({ ...base, routines, lastDone });
    expect(schedules.get("a-overdue")).toMatchObject({
      nextPass: true,
      queued: false,
      heldBy: null,
    });
    expect(schedules.get("b-overdue")).toMatchObject({
      nextPass: false,
      queued: true,
      heldBy: null,
    });
    expect(schedules.get("hourly")).toEqual({
      nextPass: false,
      queued: false,
      heldBy: null,
      dueAt: new Date(now.getTime() + 30 * 60_000),
    });
    expect(schedules.get("office")).toMatchObject({ nextPass: false, heldBy: "working-hours" });
    expect(schedules.get("off")).toEqual({
      nextPass: false,
      queued: false,
      heldBy: "off",
      dueAt: null,
    });
  });

  it("gives a failed routine's retry time", () => {
    const routines = [routine("flaky", 24 * 60)];
    const lastOffered = new Map([["flaky", hoursAgo(0.25)]]);
    const schedules = routineSchedules({ ...base, routines, lastDone: new Map(), lastOffered });
    expect(schedules.get("flaky")).toMatchObject({
      heldBy: "retry",
      dueAt: new Date(now.getTime() + 45 * 60_000),
    });
  });
});

describe("changing routine files", () => {
  let dir: string;
  const original = process.env.YARVIS_ROUTINES_DIR;

  beforeEach(async () => {
    dir = join(mkdtempSync(join(tmpdir(), "routines-change-")), "routines");
    process.env.YARVIS_ROUTINES_DIR = dir;
    await reloadRoutines();
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    process.env.YARVIS_ROUTINES_DIR = original;
    await reloadRoutines();
  });

  const find = async (name: string) =>
    (await routineCatalog()).routines.find((r) => r.name === name);

  it("turns a shipped routine on with a copy of it in the user's folder, and off again", async () => {
    const shipped = await find("review-prep");
    expect(shipped).toMatchObject({ enabled: false, source: "builtin" });

    expect(await setRoutineEnabled("review-prep", true)).toEqual({
      path: join(dir, "review-prep.md"),
    });
    const on = await find("review-prep");
    expect(on).toMatchObject({ enabled: true, source: "user", prompt: shipped?.prompt });
    expect(readFileSync(join(dir, "review-prep.md"), "utf8")).not.toContain("enabled");

    await setRoutineEnabled("review-prep", false);
    expect(await find("review-prep")).toMatchObject({ enabled: false, source: "user" });
    expect(await setRoutineEnabled("nope", true)).toEqual({ error: "no routine named 'nope'" });
  });

  it("writes tools, config and a one-off, and replaces only when asked", async () => {
    const triage = {
      name: "triage",
      description: "Triage asks",
      once: true,
      tools: ["slack_read_channel"],
      config: { channels: ["#eng"] },
      body: "Read the channels.",
    };
    await writeRoutineFile(triage);
    expect(await find("triage")).toMatchObject({
      once: true,
      tools: ["slack_read_channel"],
      config: { channels: ["#eng"] },
    });
    expect(await writeRoutineFile({ ...triage, body: "Changed." })).toEqual({
      error: "a routine named 'triage' already exists",
    });
    await writeRoutineFile({ ...triage, body: "Changed." }, { replace: true });
    expect((await find("triage"))?.prompt).toBe("Changed.");
  });

  it("deletes only the user's own file, bringing back the shipped one it replaced", async () => {
    await setRoutineEnabled("meeting-alarms", false);
    expect(await find("meeting-alarms")).toMatchObject({ source: "user", enabled: false });
    expect(await deleteRoutineFile("meeting-alarms")).toEqual({ deleted: true });
    expect(await find("meeting-alarms")).toMatchObject({ source: "builtin", enabled: true });
    expect(await deleteRoutineFile("meeting-alarms")).toEqual({
      error: "a shipped routine can only be turned off",
    });
  });

  it("removes a finished one-off, but not one rewritten after the pass started", async () => {
    await writeRoutineFile({ name: "once-a", description: "A", once: true, body: "Do A." });
    await writeRoutineFile({ name: "every-b", description: "B", every: "1h", body: "Do B." });
    const passStartedAt = new Date(Date.now() + 1000);
    expect(await removeFinishedOnceRoutines(["once-a", "every-b"], passStartedAt)).toEqual([
      "once-a",
    ]);
    expect(await find("once-a")).toBeUndefined();
    expect(await find("every-b")).toBeDefined();

    await writeRoutineFile({ name: "once-c", description: "C", once: true, body: "Do C." });
    expect(await removeFinishedOnceRoutines(["once-c"], new Date(0))).toEqual([]);
    expect(await find("once-c")).toBeDefined();
  });
});
