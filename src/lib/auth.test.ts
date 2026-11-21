import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { realCore, resetCore, stubCore } from "../test/coreApi";
import {
  base64urlToBuffer,
  bufferToBase64url,
  mintDeviceToken,
  setUpWithCode,
  signInWithPasskey,
  toCreationOptions,
  unlockVaultWithPasskey,
} from "./auth";
import { deviceToken, saveDeviceToken, signOut } from "./server";
import { setSecretBackend } from "./settings";

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

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

// happy-dom has no WebAuthn, so the browser's half of each ceremony is played here.
const credentials = {
  create: async (_: unknown): Promise<unknown> => null,
  get: async (_: unknown): Promise<unknown> => null,
};
Object.defineProperty(navigator, "credentials", { value: credentials, configurable: true });

const fakeAttestation = {
  id: "cred-1",
  rawId: bytes(1, 2, 3),
  type: "public-key",
  response: {
    attestationObject: bytes(4),
    clientDataJSON: bytes(5),
    getTransports: () => ["internal"],
  },
};
const fakeAssertion = {
  id: "cred-1",
  rawId: bytes(1, 2, 3),
  type: "public-key",
  response: {
    authenticatorData: bytes(6),
    clientDataJSON: bytes(7),
    signature: bytes(8),
    userHandle: null,
  },
};

const requestOptions = {
  ceremonyId: "c-2",
  options: {
    publicKey: { challenge: "AQID", allowCredentials: [{ id: "AQID", type: "public-key" }] },
  },
};

beforeEach(() => {
  calls = [];
  routes = {};
  signOut();
});
afterAll(() => {
  resetCore();
  fetchSpy.mockRestore();
  delete (navigator as { credentials?: unknown }).credentials;
  signOut();
});

describe("base64url", () => {
  it("round-trips bytes, including the characters base64 and base64url spell differently", () => {
    const raw = bytes(0xfb, 0xff, 0xbf, 0x00, 0x01);
    const encoded = bufferToBase64url(raw);
    expect(encoded).toBe("-_-_AAE");
    expect(new Uint8Array(base64urlToBuffer(encoded))).toEqual(new Uint8Array(raw));
  });

  it("turns the server's creation options into the buffers the browser wants", () => {
    const options = toCreationOptions({
      publicKey: {
        challenge: "AQID",
        rp: { name: "Yarvis", id: "localhost" },
        user: { id: "BAU", name: "me", displayName: "me" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        excludeCredentials: [{ id: "Bg", type: "public-key" }],
      },
    });
    expect(new Uint8Array(options.publicKey?.challenge as ArrayBuffer)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(new Uint8Array(options.publicKey?.user.id as ArrayBuffer)).toEqual(
      new Uint8Array([4, 5]),
    );
    const excluded = options.publicKey?.excludeCredentials?.[0]?.id as ArrayBuffer;
    expect(new Uint8Array(excluded)).toEqual(new Uint8Array([6]));
  });
});

describe("sign-in", () => {
  it("sets up the first passkey with the setup code and keeps the token", async () => {
    routes["POST /api/auth/setup/start"] = () =>
      Response.json({
        ceremonyId: "c-1",
        options: {
          publicKey: {
            challenge: "AQID",
            rp: { name: "Yarvis" },
            user: { id: "BAU", name: "me", displayName: "me" },
            pubKeyCredParams: [],
          },
        },
      });
    routes["POST /api/auth/setup/finish"] = () =>
      Response.json({
        token: "tok-new",
        device: { deviceId: "d1", name: "Mac", scopes: ["admin"] },
      });
    credentials.create = async () => fakeAttestation;

    const signedIn = await setUpWithCode("ABCDE-FGHIJ", "Mac");

    expect(signedIn.device.deviceId).toBe("d1");
    expect(await deviceToken()).toBe("tok-new");
    expect(calls[0]?.body).toEqual({ code: "ABCDE-FGHIJ", deviceName: "Mac" });
    expect(calls[1]?.body).toEqual({
      ceremonyId: "c-1",
      credential: {
        id: "cred-1",
        rawId: "AQID",
        type: "public-key",
        response: { attestationObject: "BA", clientDataJSON: "BQ", transports: ["internal"] },
      },
    });
  });

  it("signs in with a passkey and names the new device", async () => {
    routes["POST /api/auth/login/start"] = () => Response.json(requestOptions);
    routes["POST /api/auth/login/finish"] = () =>
      Response.json({
        token: "tok-login",
        device: { deviceId: "d2", name: "Phone", scopes: ["read"] },
      });
    credentials.get = async () => fakeAssertion;

    await signInWithPasskey("Phone");

    expect(await deviceToken()).toBe("tok-login");
    expect(calls[1]?.body).toMatchObject({
      credential: {
        id: "cred-1",
        rawId: "AQID",
        type: "public-key",
        response: {
          authenticatorData: "Bg",
          clientDataJSON: "Bw",
          signature: "CA",
          userHandle: null,
        },
      },
      ceremonyId: "c-2",
      deviceName: "Phone",
    });
  });

  it("keeps no token when the user dismisses the passkey prompt", async () => {
    routes["POST /api/auth/login/start"] = () => Response.json(requestOptions);
    credentials.get = async () => null;
    await expect(signInWithPasskey("Phone")).rejects.toThrow("no passkey was chosen");
    expect(await deviceToken()).toBeNull();
  });
});

describe("vault unlock with a passkey", () => {
  const unlockStart = {
    ceremonyId: "c-v",
    options: {
      publicKey: {
        challenge: "AQID",
        allowCredentials: [{ id: "AQID", type: "public-key" }],
        extensions: { prf: { evalByCredential: { AQID: { first: "BAUG" } } } },
      },
    },
  };

  it("sends the PRF output for the salt the server gave the passkey", async () => {
    saveDeviceToken("tok-admin");
    routes["POST /api/vault/unlock/start"] = () => Response.json(unlockStart);
    routes["POST /api/vault/unlock/finish"] = () => Response.json({ state: "unlocked" });
    let salt: ArrayBuffer | undefined;
    credentials.get = async (options: unknown) => {
      const prf = (options as CredentialRequestOptions).publicKey?.extensions as {
        prf: { evalByCredential: Record<string, { first: ArrayBuffer }> };
      };
      salt = prf.prf.evalByCredential.AQID?.first;
      return {
        ...fakeAssertion,
        getClientExtensionResults: () => ({ prf: { results: { first: bytes(9, 9) } } }),
      };
    };

    expect(await unlockVaultWithPasskey()).toEqual({ state: "unlocked" });

    expect([...new Uint8Array(salt as ArrayBuffer)]).toEqual([4, 5, 6]);
    const finish = calls.find((c) => c.url === "/api/vault/unlock/finish")?.body as {
      ceremonyId: string;
      prfFirst: string;
    };
    expect(finish.ceremonyId).toBe("c-v");
    expect(finish.prfFirst).toBe("CQk");
  });

  it("points to the recovery key when the passkey gives no PRF output", async () => {
    saveDeviceToken("tok-admin");
    routes["POST /api/vault/unlock/start"] = () => Response.json(unlockStart);
    credentials.get = async () => ({ ...fakeAssertion, getClientExtensionResults: () => ({}) });

    await expect(unlockVaultWithPasskey()).rejects.toThrow(/recovery key/);
    expect(calls.map((c) => c.url)).not.toContain("/api/vault/unlock/finish");
  });
});

describe("admin actions", () => {
  it("checks the passkey again and retries once when the server wants a recent check", async () => {
    saveDeviceToken("tok-admin");
    let mints = 0;
    routes["POST /api/devices/tokens"] = () =>
      ++mints === 1
        ? Response.json({ error: "reauth_required" }, { status: 403 })
        : Response.json({
            token: "tok-bot",
            device: { deviceId: "d3", name: "bot", scopes: ["read"] },
          });
    routes["POST /api/auth/reverify/start"] = () => Response.json(requestOptions);
    routes["POST /api/auth/reverify/finish"] = () => Response.json({});
    credentials.get = async () => fakeAssertion;

    const minted = await mintDeviceToken("bot", ["read"]);

    expect(minted.token).toBe("tok-bot");
    expect(calls.map((c) => c.url)).toEqual([
      "/api/devices/tokens",
      "/api/auth/reverify/start",
      "/api/auth/reverify/finish",
      "/api/devices/tokens",
    ]);
    // The token minted for someone else is never kept as this device's own.
    expect(await deviceToken()).toBe("tok-admin");
  });

  it("checks the passkey before switching the secrets backend", async () => {
    saveDeviceToken("tok-admin");
    let switches = 0;
    routes["POST /api/core/set_secret_backend"] = () =>
      ++switches === 1
        ? Response.json({ error: "reauth_required" }, { status: 403 })
        : Response.json({ settings: {}, copied: { count: 0 } });
    routes["POST /api/auth/reverify/start"] = () => Response.json(requestOptions);
    routes["POST /api/auth/reverify/finish"] = () => Response.json({});
    credentials.get = async () => fakeAssertion;
    // The real transport, so the call reaches the routes above.
    stubCore({ core: realCore.core });

    await setSecretBackend("keychain", null, null);

    expect(calls.map((c) => c.url)).toEqual([
      "/api/core/set_secret_backend",
      "/api/auth/reverify/start",
      "/api/auth/reverify/finish",
      "/api/core/set_secret_backend",
    ]);
  });

  it("doesn't ask for the passkey when the device just lacks the scope", async () => {
    saveDeviceToken("tok-reader");
    routes["POST /api/devices/tokens"] = () =>
      Response.json({ error: "this device doesn't have the admin scope" }, { status: 403 });
    await expect(mintDeviceToken("bot", ["read"])).rejects.toThrow("admin scope");
    expect(calls.map((c) => c.url)).toEqual(["/api/devices/tokens"]);
  });
});
