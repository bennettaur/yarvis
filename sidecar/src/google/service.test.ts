import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { GoogleCalendarClient } from "./client.ts";
import {
  clearToken,
  consumeState,
  getStoredToken,
  getValidAccessToken,
  issueState,
  saveToken,
} from "./service.ts";

const url =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (u: string) => {
    const key = Object.keys(routes).find((k) => String(u).includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  await sql`TRUNCATE google_tokens RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("google token persistence", () => {
  it("stores a single most-recent token row", async () => {
    await saveToken(db, { accessToken: "a1", refreshToken: "r1", expiresAt: Date.now() + 1e6 });
    await saveToken(db, { accessToken: "a2", refreshToken: "r2", expiresAt: Date.now() + 1e6 });
    const stored = await getStoredToken(db);
    expect(stored?.accessToken).toBe("a2");
    const rows = await db.select().from(schema.googleTokens);
    expect(rows.length).toBe(1);
  });

  it("preserves the existing refresh token when a refresh omits it", async () => {
    await saveToken(db, { accessToken: "a", refreshToken: "keep-me", expiresAt: Date.now() });
    await saveToken(
      db,
      { accessToken: "a2", expiresAt: Date.now() + 1e6 },
      "keep-me",
    );
    expect((await getStoredToken(db))?.refreshToken).toBe("keep-me");
  });

  it("clears tokens on disconnect", async () => {
    await saveToken(db, { accessToken: "a", refreshToken: "r", expiresAt: Date.now() });
    await clearToken(db);
    expect(await getStoredToken(db)).toBeNull();
  });
});

describe("getValidAccessToken", () => {
  const client = () =>
    new GoogleCalendarClient(
      "cid",
      "secret",
      fakeFetch({
        "oauth2.googleapis.com/token": {
          access_token: "refreshed",
          expires_in: 3600,
        },
      }),
    );

  it("throws when not connected", async () => {
    await expect(getValidAccessToken(db, client())).rejects.toThrow(/not connected/);
  });

  it("returns the stored token when it is still valid", async () => {
    await saveToken(db, { accessToken: "fresh", refreshToken: "r", expiresAt: Date.now() + 1e6 });
    expect(await getValidAccessToken(db, client())).toBe("fresh");
  });

  it("refreshes and persists when the token is expired", async () => {
    await saveToken(db, { accessToken: "stale", refreshToken: "r", expiresAt: Date.now() - 1000 });
    expect(await getValidAccessToken(db, client())).toBe("refreshed");
    const stored = await getStoredToken(db);
    expect(stored?.accessToken).toBe("refreshed");
    expect(stored?.refreshToken).toBe("r"); // preserved across refresh
  });

  it("throws when expired and no refresh token is stored", async () => {
    await saveToken(db, { accessToken: "stale", expiresAt: Date.now() - 1000 });
    await expect(getValidAccessToken(db, client())).rejects.toThrow(/no refresh token/);
  });
});

describe("oauth state nonces", () => {
  it("are single-use and reject unknown values", () => {
    const state = issueState();
    expect(consumeState(state)).toBe(true);
    expect(consumeState(state)).toBe(false); // already consumed
    expect(consumeState("never-issued")).toBe(false);
  });
});
