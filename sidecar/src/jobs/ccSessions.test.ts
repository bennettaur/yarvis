import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { ccSessionDigestJob, parseSessionDigest, transcriptMaterial } from "./ccSessions.ts";
import { saveJobConfig } from "./config.ts";
import { runJob } from "./scheduler.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

const config = {
  port: 0,
  token: "t",
  tokenGenerated: false,
  attentionToken: "a",
  mcpToken: "m",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
} as Config;

const PROJECT_DIR = "-Users-me-dev-app";
let claudeHome: string;
let settingsDir: string;
const previousHome = process.env.CLAUDE_HOME;
const previousSettingsPath = process.env.YARVIS_SETTINGS_PATH;

/** One transcript line in Claude Code's JSONL shape. */
function line(role: "user" | "assistant", text: string): string {
  return `${JSON.stringify({ type: role, message: { role, content: text } })}\n`;
}

function writeTranscript(sessionId: string, body: string): string {
  const file = join(claudeHome, "projects", PROJECT_DIR, `${sessionId}.jsonl`);
  writeFileSync(file, body);
  return file;
}

beforeEach(async () => {
  await sql`TRUNCATE cc_session_digests, job_runs, memories, events RESTART IDENTITY CASCADE`;
  claudeHome = mkdtempSync(join(tmpdir(), "yarvis-claude-"));
  mkdirSync(join(claudeHome, "projects", PROJECT_DIR), { recursive: true });
  process.env.CLAUDE_HOME = claudeHome;
  // job_config now lives in ~/.yarvis/settings.json, not Postgres — point this
  // suite at an isolated file so it never touches the real one.
  settingsDir = mkdtempSync(join(tmpdir(), "yarvis-jobs-settings-"));
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
  await saveJobConfig({ ccDigestEnabled: true, ccDigestProjectDirs: [PROJECT_DIR] });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CLAUDE_HOME;
  else process.env.CLAUDE_HOME = previousHome;
  if (previousSettingsPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = previousSettingsPath;
  rmSync(claudeHome, { recursive: true, force: true });
  rmSync(settingsDir, { recursive: true, force: true });
});

afterAll(async () => {
  await sql.end();
});

describe("the transcript sweep", () => {
  /**
   * An abandoned transcript takes the short-circuit before any model call, which
   * is what makes the bookkeeping testable without a provider.
   */
  it("records an abandoned transcript once and leaves it alone next time", async () => {
    writeTranscript("session-a", line("user", "never mind"));

    const first = await runJob(ccSessionDigestJob, config, db);
    expect(first.status).toBe("ok");
    expect(first.detail).toContain("skipped 1");

    const rows = await sql`SELECT session_id, source_mtime_ms FROM cc_session_digests`;
    expect(rows.length).toBe(1);

    // The mtime stored must not be *above* the file's real one, or the "unchanged
    // since last sweep" check never holds and the session is re-digested nightly.
    const second = await runJob(ccSessionDigestJob, config, db);
    expect(second.status).toBe("skipped");
    expect(second.detail).toBe("no new sessions");
    expect((await sql`SELECT count(*)::int AS n FROM cc_session_digests`)[0]!.n).toBe(1);
  });

  it("picks a session back up once it has grown", async () => {
    writeTranscript("session-a", line("user", "never mind"));
    await runJob(ccSessionDigestJob, config, db);

    // Resumed and extended: still short, so it takes the same cheap path, but it
    // has to be reconsidered rather than skipped.
    writeTranscript("session-a", line("user", "never mind") + line("assistant", "picking back up"));
    const again = await runJob(ccSessionDigestJob, config, db);
    expect(again.status).toBe("ok");
    expect(again.detail).toContain("skipped 1");
  });

  it("ignores a project the user has not allowed", async () => {
    mkdirSync(join(claudeHome, "projects", "-Users-me-dev-secret"), { recursive: true });
    writeFileSync(
      join(claudeHome, "projects", "-Users-me-dev-secret", "session-b.jsonl"),
      line("user", "client work"),
    );
    writeTranscript("session-a", line("user", "never mind"));

    await runJob(ccSessionDigestJob, config, db);
    const rows = await sql`SELECT session_id FROM cc_session_digests`;
    expect(rows.map((r) => r.session_id)).toEqual(["session-a"]);
  });

  it("reports no sessions when the allowed project has none", async () => {
    const result = await runJob(ccSessionDigestJob, config, db);
    expect(result.status).toBe("skipped");
    expect(result.detail).toBe("no new sessions");
  });
});

describe("session digest parsing", () => {
  it("splits the three labelled sections", () => {
    const digest = parseSessionDigest(
      [
        "WORK: Added the pgvector index.",
        "DECISIONS: Kept 1536 dims because re-embedding is expensive.",
        "FEEDBACK: Stop restating the code in comments.",
      ].join("\n"),
    );
    expect(digest.work).toBe("Added the pgvector index.");
    expect(digest.decisions).toContain("1536");
    expect(digest.feedback).toBe("Stop restating the code in comments.");
  });

  it("bounds a section, so an untrusted transcript can't write an essay as guidance", () => {
    const digest = parseSessionDigest(`WORK: fine\nFEEDBACK: ${"x".repeat(9_000)}`);
    expect(digest.feedback!.length).toBeLessThanOrEqual(2_000);
  });

  it("keeps both ends of a transcript too long to send whole", () => {
    const material = transcriptMaterial([
      { role: "user", text: `START ${"x".repeat(30_000)} END`, timestamp: null },
    ]);
    expect(material).toContain("START");
    expect(material).toContain("END");
    expect(material).toContain("(middle omitted)");
  });
});
