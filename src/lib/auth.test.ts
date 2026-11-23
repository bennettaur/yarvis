import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { realCore, resetCore, stubCore } from "../test/coreApi";
import {
  finishSetup,
  mintDeviceToken,
  setCodePrompter,
  signIn,
  startSetup,
  unlockVault,
} from "./auth";
import { deviceToken, saveDeviceToken, signOut } from "./server";
import { setSecretBackend } from "./settings";

type Call = { url: string; body: unknown };
let calls: Call[] = [];
let routes: Record<string, () => Response> = {};

const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
  url: string | URL | Request,
  init?: RequestInit,
) => {
  const path = String(url);
  calls.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  const route = routes[`${init?.method ?? "GET"} ${path}`];
  return route ? route() : new Response('{"error":"not found"}', { status: 404 });
}) as typeof fetch);

let removePrompter: (() => void) | null = null;
/** Answers the code prompt the way a user typing `code` would, counting each ask. */
function promptAnswers(code: string | null) {
  const asked = { count: 0 };
  removePrompter?.();
  removePrompter = setCodePrompter(async () => {
    asked.count++;
    return code;
  });
  return asked;
}

beforeEach(() => {
  calls = [];
  routes = {};
  removePrompter?.();
  removePrompter = null;
  signOut();
});
afterAll(() => {
  removePrompter?.();
  resetCore();
  fetchSpy.mockRestore();
  signOut();
});

const device = { deviceId: "d1", name: "Mac", scopes: ["read", "admin"] };

describe("setup and sign-in", () => {
  it("starts setup with the code and passphrase, and keeps no token until told to", async () => {
    routes["POST /api/auth/setup/start"] = () =>
      Response.json({
        enrollmentId: "e1",
        secret: "ABC",
        otpauthUri: "otpauth://x",
        qrSvg: "<svg/>",
      });
    routes["POST /api/auth/setup/finish"] = () =>
      Response.json({ token: "tok-1", device, backupCodes: ["AAAAA-BBBBB"] });

    const enrollment = await startSetup("ABCDE-FGHIJ", "a long passphrase", "Mac");
    const done = await finishSetup(enrollment.enrollmentId, "123456");

    expect(calls.map((c) => c.body)).toEqual([
      { code: "ABCDE-FGHIJ", passphrase: "a long passphrase", deviceName: "Mac" },
      { enrollmentId: "e1", code: "123456" },
    ]);
    expect(done.backupCodes).toEqual(["AAAAA-BBBBB"]);
    // Saving the token signs in and leaves the setup screen before the backup
    // codes have been shown, so that's the caller's call.
    expect(await deviceToken()).toBeNull();
  });

  it("signs in with a code or a backup code and keeps the token", async () => {
    routes["POST /api/auth/login"] = () => Response.json({ token: "tok-2", device });

    await signIn("a long passphrase", { code: "123456" }, "Phone");
    expect(await deviceToken()).toBe("tok-2");
    await signIn("a long passphrase", { backupCode: "AAAAA-BBBBB" }, "Phone");

    expect(calls.map((c) => c.body)).toEqual([
      { passphrase: "a long passphrase", code: "123456", deviceName: "Phone" },
      { passphrase: "a long passphrase", backupCode: "AAAAA-BBBBB", deviceName: "Phone" },
    ]);
  });

  it("keeps no token when the server refuses the sign-in", async () => {
    routes["POST /api/auth/login"] = () =>
      Response.json({ error: "wrong passphrase or code" }, { status: 401 });
    await expect(signIn("x", { code: "000000" }, "Phone")).rejects.toThrow("wrong passphrase");
    expect(await deviceToken()).toBeNull();
  });
});

describe("the vault", () => {
  it("unlocks with the vault passphrase", async () => {
    saveDeviceToken("tok-admin");
    routes["POST /api/vault/unlock"] = () => Response.json({ state: "unlocked" });
    expect(await unlockVault("the vault's passphrase")).toEqual({ state: "unlocked" });
    expect(calls[0]?.body).toEqual({ passphrase: "the vault's passphrase" });
  });
});

describe("admin actions", () => {
  it("asks for a code and retries once when the server wants a recent one", async () => {
    saveDeviceToken("tok-admin");
    let mints = 0;
    routes["POST /api/devices/tokens"] = () =>
      ++mints === 1
        ? Response.json({ error: "reauth_required" }, { status: 403 })
        : Response.json({
            token: "tok-bot",
            device: { deviceId: "d3", name: "bot", scopes: ["read"] },
          });
    routes["POST /api/auth/reverify"] = () => Response.json({ verifiedAt: 1 });
    const asked = promptAnswers("123456");

    const minted = await mintDeviceToken("bot", ["read"]);

    expect(minted.token).toBe("tok-bot");
    expect(asked.count).toBe(1);
    expect(calls.map((c) => c.url)).toEqual([
      "/api/devices/tokens",
      "/api/auth/reverify",
      "/api/devices/tokens",
    ]);
    expect(calls[1]?.body).toEqual({ code: "123456" });
    // The token minted for someone else is never kept as this device's own.
    expect(await deviceToken()).toBe("tok-admin");
  });

  it("asks for a code before switching the secrets backend", async () => {
    saveDeviceToken("tok-admin");
    let switches = 0;
    routes["POST /api/core/set_secret_backend"] = () =>
      ++switches === 1
        ? Response.json({ error: "reauth_required" }, { status: 403 })
        : Response.json({ settings: {}, copied: { count: 0 } });
    routes["POST /api/auth/reverify"] = () => Response.json({ verifiedAt: 1 });
    promptAnswers("123456");
    // The real transport, so the call reaches the routes above.
    stubCore({ core: realCore.core });

    await setSecretBackend("keychain", null, null);

    expect(calls.map((c) => c.url)).toEqual([
      "/api/core/set_secret_backend",
      "/api/auth/reverify",
      "/api/core/set_secret_backend",
    ]);
  });

  it("gives up without retrying when the user cancels the code prompt", async () => {
    saveDeviceToken("tok-admin");
    routes["POST /api/devices/tokens"] = () =>
      Response.json({ error: "reauth_required" }, { status: 403 });
    promptAnswers(null);
    await expect(mintDeviceToken("bot", ["read"])).rejects.toThrow("reauth_required");
    expect(calls.map((c) => c.url)).toEqual(["/api/devices/tokens"]);
  });

  it("fails the action on a wrong code and keeps this device signed in", async () => {
    saveDeviceToken("tok-admin");
    routes["POST /api/devices/tokens"] = () =>
      Response.json({ error: "reauth_required" }, { status: 403 });
    routes["POST /api/auth/reverify"] = () =>
      Response.json({ error: "wrong code" }, { status: 403 });
    promptAnswers("000000");
    await expect(mintDeviceToken("bot", ["read"])).rejects.toThrow("wrong code");
    expect(calls.map((c) => c.url)).toEqual(["/api/devices/tokens", "/api/auth/reverify"]);
    expect(await deviceToken()).toBe("tok-admin");
  });

  it("asks only once when the retried action still wants a code", async () => {
    saveDeviceToken("tok-admin");
    routes["POST /api/devices/tokens"] = () =>
      Response.json({ error: "reauth_required" }, { status: 403 });
    routes["POST /api/auth/reverify"] = () => Response.json({ verifiedAt: 1 });
    const asked = promptAnswers("123456");
    await expect(mintDeviceToken("bot", ["read"])).rejects.toThrow("reauth_required");
    expect(asked.count).toBe(1);
  });

  it("doesn't ask for a code when the device just lacks the scope", async () => {
    saveDeviceToken("tok-reader");
    routes["POST /api/devices/tokens"] = () =>
      Response.json({ error: "this device doesn't have the admin scope" }, { status: 403 });
    const asked = promptAnswers("123456");
    await expect(mintDeviceToken("bot", ["read"])).rejects.toThrow("admin scope");
    expect(asked.count).toBe(0);
    expect(calls.map((c) => c.url)).toEqual(["/api/devices/tokens"]);
  });
});
