import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  base64urlToBuffer,
  bufferToBase64url,
  mintDeviceToken,
  setUpWithCode,
  signInWithPasskey,
  toCreationOptions,
} from "./auth";
import { deviceToken, saveDeviceToken, signOut } from "./server";

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
  publicKey: { challenge: "AQID", allowCredentials: [{ id: "AQID", type: "public-key" }] },
};

beforeEach(() => {
  calls = [];
  routes = {};
  signOut();
});
afterAll(() => {
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
      Response.json({ token: "tok-new", device: { id: "d1", name: "Mac", scopes: ["admin"] } });
    credentials.create = async () => fakeAttestation;

    const signedIn = await setUpWithCode("ABCDE-FGHIJ", "Mac");

    expect(signedIn.device.id).toBe("d1");
    expect(await deviceToken()).toBe("tok-new");
    expect(calls[0]?.body).toEqual({ code: "ABCDE-FGHIJ", deviceName: "Mac" });
    expect(calls[1]?.body).toEqual({
      ceremonyId: "c-1",
      deviceName: "Mac",
      credential: {
        id: "cred-1",
        rawId: "AQID",
        type: "public-key",
        response: { attestationObject: "BA", clientDataJSON: "BQ", transports: ["internal"] },
      },
    });
  });

  it("signs in with a passkey when the start route answers bare options", async () => {
    routes["POST /api/auth/login/start"] = () => Response.json(requestOptions);
    routes["POST /api/auth/login/finish"] = () =>
      Response.json({ token: "tok-login", device: { id: "d2", name: "Phone", scopes: ["read"] } });
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

describe("admin actions", () => {
  it("checks the passkey again and retries once when the server wants a recent check", async () => {
    saveDeviceToken("tok-admin");
    let mints = 0;
    routes["POST /api/devices/tokens"] = () =>
      ++mints === 1
        ? Response.json({ error: "check your passkey again" }, { status: 403 })
        : Response.json({ token: "tok-bot", device: { id: "d3", name: "bot", scopes: ["read"] } });
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
});
