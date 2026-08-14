import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

/**
 * The speech settings live in Postgres rather than the frontend because the
 * Telegram bot runs in this process and cannot read a browser's localStorage
 * (see issue #226). These cover the round trip every surface depends on.
 */

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });

/**
 * `null` means "no database configured". Not `undefined`: passing that
 * explicitly would trigger the default parameter and quietly give the app a
 * database, which is the opposite of what those tests are checking.
 */
function app(databaseUrl: string | null = url): ReturnType<typeof createApp> {
  const config: Config = {
    port: 0,
    token: "test-token",
    tokenGenerated: false,
    attentionToken: "test-attention-token",
    allowedOrigins: null,
    databaseUrl: databaseUrl ?? undefined,
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets: {},
    customProviderSecrets: {},
    mcpSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  };
  return createApp(config);
}

const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

const patch = (body: unknown, target = app()) =>
  target.request("/api/voice/config", {
    method: "PATCH",
    headers: jsonAuth,
    body: JSON.stringify(body),
  });

const read = (target = app()) => target.request("/api/voice/config", { headers: auth });

beforeEach(async () => {
  await sql`TRUNCATE voice_config RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("voice config", () => {
  it("requires the bearer token", async () => {
    expect((await app().request("/api/voice/config")).status).toBe(401);
  });

  it("answers defaults before anything is configured", async () => {
    const body = (await (await read()).json()) as Record<string, unknown>;
    expect(body.sttProvider).toBe("");
    // Speaking replies is the useful default; hands-free is not, because it can
    // turn ambient speech into a turn.
    expect(body.speakReplies).toBe(true);
    expect(body.handsFree).toBe(false);
  });

  it("saves and reads back a full configuration", async () => {
    const saved = await patch({
      sttProvider: "custom:abc",
      sttModel: "gemma4:latest",
      sttLanguage: "en",
      ttsProvider: "custom:abc",
      ttsModel: "mlx-community/Soprano-1.1-80M-bf16",
      ttsExtras: { response_format: "wav" },
      handsFree: true,
    });
    expect(saved.status).toBe(200);

    const body = (await (await read()).json()) as Record<string, unknown>;
    expect(body.sttModel).toBe("gemma4:latest");
    expect(body.ttsExtras).toEqual({ response_format: "wav" });
    expect(body.handsFree).toBe(true);
  });

  it("keeps one row across repeated saves", async () => {
    await patch({ sttModel: "first" });
    await patch({ ttsModel: "second" });

    const [{ count }] = await sql<{ count: string }[]>`SELECT count(*) FROM voice_config`;
    expect(Number(count)).toBe(1);
    // A later save must not wipe what an earlier one set.
    const body = (await (await read()).json()) as Record<string, unknown>;
    expect(body.sttModel).toBe("first");
    expect(body.ttsModel).toBe("second");
  });

  it("treats blank as clearing a selection", async () => {
    await patch({ sttProvider: "huggingface", ttsRefAudio: "data:audio/wav;base64,AAAA" });
    await patch({ sttProvider: "", ttsRefAudio: "" });

    const body = (await (await read()).json()) as Record<string, unknown>;
    expect(body.sttProvider).toBe("");
    expect(body.ttsRefAudio).toBe("");
  });

  it("rejects a reference clip that is not audio, and a bad language", async () => {
    expect((await patch({ ttsRefAudio: "https://example.com/a.wav" })).status).toBe(400);
    expect((await patch({ sttLanguage: "english" })).status).toBe(400);
  });

  it("refuses extras that would rewrite the synthesis request", async () => {
    expect((await patch({ ttsExtras: { model: "other" } })).status).toBe(400);
  });

  it("serves defaults rather than failing when there is no database", async () => {
    const res = await read(app(null));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).speakReplies).toBe(true);
  });

  it("refuses to save with no database", async () => {
    expect((await patch({ sttModel: "x" }, app(null))).status).toBe(503);
  });
});
