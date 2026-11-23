import { invoke } from "@tauri-apps/api/core";

/**
 * The connection to yarvis-server (`docs/client-server.md`). The UI is always
 * served by the server it talks to, in a browser and in the Tauri window, so
 * every request goes to the page's own origin and needs no CORS.
 *
 * Every call carries the device token as a bearer header. WebSockets can't set
 * headers, so they send it as their first message instead (see `openServerSocket`).
 */

/**
 * In a browser the token sits in localStorage, so a script injected into the
 * page could read it and act as this device until it is revoked. That is the
 * price of signing in once per browser rather than on every load. The Tauri
 * app keeps its token in the Keychain and hands it over on request instead.
 */
const TOKEN_KEY = "yarvis.deviceToken";

/** True inside the Tauri window. `mockIPC` (the demo) sets the same global. */
export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let tokenPromise: Promise<string | null> | null = null;

/** The device token, or null when this client hasn't signed in. */
export function deviceToken(): Promise<string | null> {
  if (!tokenPromise) {
    tokenPromise = (async () => {
      if (inTauri()) {
        try {
          const conn = await invoke<{ token: string | null } | null>("get_server_connection");
          if (conn?.token) return conn.token;
        } catch {
          // An app without the command, or one not paired yet: fall back to
          // whatever this webview signed in with.
        }
      }
      return readStoredToken();
    })();
  }
  return tokenPromise;
}

/** Keeps the token a sign-in returned. */
export function saveDeviceToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage blocked: the token still lasts for this page load.
  }
  tokenPromise = Promise.resolve(token);
  signedOut = false;
  notifyAuth(true);
}

type AuthListener = (signedIn: boolean) => void;
const authListeners = new Set<AuthListener>();

function notifyAuth(signedIn: boolean): void {
  for (const listener of authListeners) listener(signedIn);
}

/** True once signed out, so the 401s and 4401 closes that follow don't sign out again. */
let signedOut = false;
/** True while `signOutThisDevice` waits on the server; it signs out itself after. */
let signingOut = false;
let signOutNotice: string | null = null;

/**
 * Forgets the token and tells the app to show sign-in. Called on any 401, so a
 * revoked or expired device lands on the sign-in screen rather than on a page
 * of failed requests.
 */
export function signOut(): void {
  if (signedOut || signingOut) return;
  signedOut = true;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: nothing to clear.
  }
  tokenPromise = Promise.resolve(null);
  notifyAuth(false);
}

/** Shown on the sign-in screen when the server may still list this device. */
export const STILL_LISTED_NOTICE =
  "Signed out of this browser, but the server didn't confirm it revoked this device. If it's still listed under Settings → Devices, revoke it from another device.";

/** How long sign-out waits for the server before forgetting the token anyway. */
const SIGN_OUT_TIMEOUT_MS = 5_000;

/**
 * Signs this device out: asks the server to revoke its token, then forgets
 * the token whatever the answer, so a server that can't be reached never
 * keeps anyone signed in. A 401 means the token was already gone. Any other
 * failure leaves a notice for the sign-in screen, since the device may still
 * be listed. The revocation closes this device's sockets with 4401 while the
 * request is out; those don't sign out a second time.
 */
export async function signOutThisDevice(timeoutMs = SIGN_OUT_TIMEOUT_MS): Promise<void> {
  if (signingOut) return;
  signingOut = true;
  let notice: string | null = null;
  try {
    const token = await deviceToken();
    if (token) {
      // A bare fetch: serverFetch would sign out on the 401 itself. The
      // timeout keeps a stalled server from keeping anyone signed in.
      const res = await fetch("/api/devices/me", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok && res.status !== 401) notice = STILL_LISTED_NOTICE;
    }
  } catch {
    notice = STILL_LISTED_NOTICE;
  } finally {
    signingOut = false;
  }
  signOutNotice = notice;
  signOut();
}

/** The notice the last sign-out left, once. */
export function takeSignOutNotice(): string | null {
  const notice = signOutNotice;
  signOutNotice = null;
  return notice;
}

/** Calls `cb` with true after a sign-in and false after a sign-out. */
export function onAuthChange(cb: AuthListener): () => void {
  authListeners.add(cb);
  return () => {
    authListeners.delete(cb);
  };
}

/**
 * Fetch against the server with the device token. A 401 signs the device out.
 * `path` starts with `/api/`.
 */
export async function serverFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await deviceToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && token) signOut();
  return res;
}

/** The WebSocket URL for a server path, or null when the page has no http(s) origin. */
export function serverSocketUrl(path: string): string | null {
  if (typeof location === "undefined") return null;
  if (location.protocol !== "http:" && location.protocol !== "https:") return null;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${path}`;
}

/** The close code for a token the server doesn't accept; the device signs in again. */
export const WS_UNAUTHORIZED = 4401;
/**
 * True for a close the server chose because of the request (4400, 4401,
 * 4403), which reconnecting won't change. A 1011 or a dropped network is
 * worth retrying.
 */
export const refusedByServer = (code: number): boolean => code >= 4000 && code < 5000;

/**
 * Opens a WebSocket to the server and sends the auth message, with `hello`'s
 * fields added to it. Resolves null when there is no token or no server to
 * reach. A close with 4401 signs the device out.
 */
export async function openServerSocket(
  path: string,
  hello: Record<string, unknown> = {},
): Promise<WebSocket | null> {
  const url = serverSocketUrl(path);
  const token = await deviceToken();
  if (!url || !token) return null;
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ ...hello, type: "auth", token }));
  });
  socket.addEventListener("close", (e) => {
    if (e.code === WS_UNAUTHORIZED) signOut();
  });
  return socket;
}
