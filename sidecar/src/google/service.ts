import { desc } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { googleTokens, type GoogleToken } from "../db/schema.ts";
import type { GoogleCalendarClient, TokenResponse } from "./client.ts";

/** Refresh a little early so a token doesn't expire mid-request. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Outstanding OAuth `state` nonces, for CSRF protection between issuing the
 * consent URL and handling the callback. Kept in memory (the flow completes
 * within one app session) with a TTL and a cap so abandoned consent attempts
 * don't accumulate or stay valid indefinitely.
 */
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_STATES = 64;

function pruneStates(now: number): void {
  for (const [state, issuedAt] of pendingStates) {
    if (now - issuedAt > STATE_TTL_MS) pendingStates.delete(state);
  }
  // Bound the set even if many flows are started without finishing: drop oldest.
  while (pendingStates.size >= MAX_PENDING_STATES) {
    const oldest = pendingStates.keys().next().value;
    if (oldest === undefined) break;
    pendingStates.delete(oldest);
  }
}

export function issueState(): string {
  const now = Date.now();
  pruneStates(now);
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const state = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  pendingStates.set(state, now);
  return state;
}

/** Validates and consumes a state nonce; false if unknown or expired (CSRF). */
export function consumeState(state: string): boolean {
  const issuedAt = pendingStates.get(state);
  if (issuedAt === undefined) return false;
  pendingStates.delete(state);
  return Date.now() - issuedAt <= STATE_TTL_MS;
}

/** Returns the stored token row (most recent), or null if not connected. */
export async function getStoredToken(db: Db): Promise<GoogleToken | null> {
  const [row] = await db
    .select()
    .from(googleTokens)
    .orderBy(desc(googleTokens.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Persists tokens for the single connected account. Replaces any existing row;
 * preserves the refresh token when a refresh response omits it (Google only
 * returns it on first consent).
 */
export async function saveToken(
  db: Db,
  token: TokenResponse,
  existingRefreshToken?: string | null,
): Promise<void> {
  const refreshToken = token.refreshToken ?? existingRefreshToken ?? null;
  await db.delete(googleTokens);
  await db.insert(googleTokens).values({
    accessToken: token.accessToken,
    refreshToken,
    scope: token.scope ?? null,
    expiresAt: new Date(token.expiresAt),
    updatedAt: new Date(),
  });
}

export async function clearToken(db: Db): Promise<void> {
  await db.delete(googleTokens);
}

/**
 * Returns a valid access token, transparently refreshing with the stored
 * refresh token when the current one is expired (or about to be). Throws when
 * no connection exists or the refresh fails.
 */
export async function getValidAccessToken(
  db: Db,
  client: GoogleCalendarClient,
): Promise<string> {
  const stored = await getStoredToken(db);
  if (!stored) throw new Error("google calendar not connected");

  const expiresAt = stored.expiresAt?.getTime() ?? 0;
  if (Date.now() < expiresAt - EXPIRY_SKEW_MS) {
    return stored.accessToken;
  }
  if (!stored.refreshToken) {
    throw new Error("google access token expired and no refresh token stored");
  }
  const refreshed = await client.refresh(stored.refreshToken);
  await saveToken(db, refreshed, stored.refreshToken);
  return refreshed.accessToken;
}
