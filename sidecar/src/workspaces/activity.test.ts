import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ccProjectDirFor } from "../cc/sessions.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
  type ActivityRecapper,
  activityMaterial,
  clearRecapCache,
  recapWorkspaceSession,
} from "./activity.ts";

const ROOT = "/Users/me/dev/yarvis-workspaces/fix.the_bug";
const PROJECT_DIR = ccProjectDirFor(ROOT);

let claudeHome: string;
const previousHome = process.env.CLAUDE_HOME;

function line(role: "user" | "assistant", text: string, minute = 0): string {
  return `${JSON.stringify({
    type: role,
    timestamp: `2026-05-01T10:${String(minute).padStart(2, "0")}:00Z`,
    message: { role, content: role === "user" ? text : [{ type: "text", text }] },
  })}\n`;
}

function writeSession(sessionId: string, body: string, mtime?: Date): void {
  const file = join(claudeHome, "projects", PROJECT_DIR, `${sessionId}.jsonl`);
  writeFileSync(file, body);
  if (mtime) utimesSync(file, mtime, mtime);
}

/** Counts its calls and answers with a fixed recap. */
function fakeRecapper(answer = "Adding a login page; the agent finished and opened a PR.") {
  const calls: Parameters<ActivityRecapper>[0][] = [];
  const recapper: ActivityRecapper = async (input) => {
    calls.push(input);
    return answer;
  };
  return { calls, recapper };
}

const input = {
  config: {} as Config,
  db: {} as Db,
  rootPath: ROOT,
};

beforeEach(() => {
  claudeHome = mkdtempSync(join(tmpdir(), "yarvis-claude-"));
  mkdirSync(join(claudeHome, "projects", PROJECT_DIR), { recursive: true });
  process.env.CLAUDE_HOME = claudeHome;
  clearRecapCache();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CLAUDE_HOME;
  else process.env.CLAUDE_HOME = previousHome;
  rmSync(claudeHome, { recursive: true, force: true });
});

describe("ccProjectDirFor", () => {
  it("encodes a path the way Claude Code names its project directories", () => {
    expect(ccProjectDirFor("/Users/me/dev/yarvis-workspaces/.repos/a_b")).toBe(
      "-Users-me-dev-yarvis-workspaces--repos-a-b",
    );
  });
});

describe("recapWorkspaceSession", () => {
  it("recaps the newest session from its prompts and last reply", async () => {
    writeSession("old", line("user", "an older session"), new Date("2026-04-01T00:00:00Z"));
    writeSession(
      "new",
      line("user", "add a login page", 1) + line("assistant", "Done, PR is open.", 2),
    );
    const { calls, recapper } = fakeRecapper();

    const activity = await recapWorkspaceSession(input, recapper);

    expect(activity).toEqual({
      sessionId: "new",
      lastActivityAt: "2026-05-01T10:02:00Z",
      recap: "Adding a login page; the agent finished and opened a PR.",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.activity.prompts.map((p) => p.text)).toEqual(["add a login page"]);
    expect(calls[0]!.activity.lastReply?.text).toBe("Done, PR is open.");
  });

  it("reuses the recap until the session changes", async () => {
    const mtime = new Date("2026-05-01T10:05:00Z");
    writeSession("s1", line("user", "add a login page"), mtime);
    const { calls, recapper } = fakeRecapper();

    await recapWorkspaceSession(input, recapper);
    await recapWorkspaceSession(input, recapper);
    expect(calls).toHaveLength(1);

    writeSession(
      "s1",
      line("user", "add a login page") + line("user", "and a logout button"),
      new Date("2026-05-01T10:06:00Z"),
    );
    await recapWorkspaceSession(input, recapper);
    expect(calls).toHaveLength(2);
  });

  it("shares one model call between asks made while it runs", async () => {
    writeSession("s1", line("user", "add a login page"));
    let calls = 0;
    let finish: (text: string) => void = () => {};
    const recapper: ActivityRecapper = () => {
      calls += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };

    const first = recapWorkspaceSession(input, recapper);
    const second = recapWorkspaceSession(input, recapper);
    // Both asks have to reach the cache before the recap finishes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    finish("Working on the login page.");

    expect((await first)?.recap).toBe("Working on the login page.");
    expect((await second)?.recap).toBe("Working on the login page.");
    expect(calls).toBe(1);
  });

  it("tries again after a failed recap", async () => {
    writeSession("s1", line("user", "add a login page"));
    let calls = 0;
    const recapper: ActivityRecapper = async () => {
      calls += 1;
      if (calls === 1) throw new Error("provider down");
      return "Working on the login page.";
    };

    await expect(recapWorkspaceSession(input, recapper)).rejects.toThrow("provider down");
    expect((await recapWorkspaceSession(input, recapper))?.recap).toBe(
      "Working on the login page.",
    );
  });

  it("reports an empty recap as none", async () => {
    writeSession("s1", line("user", "add a login page"));
    const { recapper } = fakeRecapper("");
    expect((await recapWorkspaceSession(input, recapper))?.recap).toBeNull();
  });

  it("skips the model when nothing was typed yet", async () => {
    writeSession("s1", line("assistant", "Ready when you are."));
    const { calls, recapper } = fakeRecapper();

    const activity = await recapWorkspaceSession(input, recapper);

    expect(activity?.recap).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null when no session ran at the workspace root", async () => {
    rmSync(join(claudeHome, "projects", PROJECT_DIR), { recursive: true });
    const { recapper } = fakeRecapper();
    expect(await recapWorkspaceSession(input, recapper)).toBeNull();
  });

  it("reads only the end of a long transcript", async () => {
    // A prompt that only exists past the 4 MB tail must not be picked up, and the
    // cut mid-line must not break parsing of what follows.
    const filler = line("assistant", "x".repeat(5 * 1024 * 1024));
    writeSession("s1", line("user", "from the start") + filler + line("user", "from the end", 9));
    const { calls, recapper } = fakeRecapper();

    await recapWorkspaceSession(input, recapper);

    expect(calls[0]!.activity.prompts.map((p) => p.text)).toEqual(["from the end"]);
  });
});

describe("activityMaterial", () => {
  it("numbers the prompts and keeps the end of a long reply", () => {
    const material = activityMaterial({
      lastActivityAt: null,
      prompts: [{ text: "first", timestamp: null }],
      lastReply: { text: `${"a".repeat(5_000)}THE END`, timestamp: null },
    });
    expect(material).toStartWith("Prompt 1:\nfirst");
    expect(material).toEndWith("THE END");
  });

  it("says when the agent hasn't replied, and cuts a long prompt", () => {
    const material = activityMaterial({
      lastActivityAt: null,
      prompts: [{ text: "p".repeat(3_000), timestamp: "2026-05-01T10:00:00Z" }],
      lastReply: null,
    });
    expect(material).toStartWith("Prompt 1 (2026-05-01T10:00:00Z):\n");
    expect(material).toContain(`${"p".repeat(2_000)}…`);
    expect(material).not.toContain("p".repeat(2_001));
    expect(material).toEndWith("The agent has not replied yet.");
  });

  it("scrubs credentials pasted into a prompt", () => {
    const material = activityMaterial({
      lastActivityAt: null,
      prompts: [{ text: "use ghp_abcdefghijklmnopqrstuvwxyz0123", timestamp: null }],
      lastReply: null,
    });
    expect(material).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(material).toContain("[redacted-token]");
  });
});
