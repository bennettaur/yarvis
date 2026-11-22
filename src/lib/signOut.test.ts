import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  deviceToken,
  onAuthChange,
  STILL_LISTED_NOTICE,
  saveDeviceToken,
  serverFetch,
  signOut,
  signOutThisDevice,
  takeSignOutNotice,
} from "./server";

let answer: (init?: RequestInit) => Response | Promise<Response> = () =>
  Response.json({ revokedAt: 1 });
const calls: { url: string; init?: RequestInit }[] = [];
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
  url: string | URL | Request,
  init?: RequestInit,
) => {
  calls.push({ url: String(url), init });
  return answer(init);
}) as typeof fetch);

let signOuts = 0;
const off = onAuthChange((signedIn) => {
  if (!signedIn) signOuts++;
});

beforeEach(() => {
  calls.length = 0;
  signOuts = 0;
  takeSignOutNotice();
  answer = () => Response.json({ revokedAt: 1 });
  saveDeviceToken("tok-me");
});
afterAll(() => {
  off();
  fetchSpy.mockRestore();
  signOut();
});

describe("signing this device out", () => {
  it("revokes the token on the server, then forgets it", async () => {
    await signOutThisDevice();
    expect(calls.map((c) => [c.url, c.init?.method])).toEqual([["/api/devices/me", "DELETE"]]);
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer tok-me");
    expect(await deviceToken()).toBeNull();
    expect(signOuts).toBe(1);
    expect(takeSignOutNotice()).toBeNull();
  });

  it("forgets the token quietly when the server says it was already gone", async () => {
    answer = () => Response.json({ error: "sign in first" }, { status: 401 });
    await signOutThisDevice();
    expect(await deviceToken()).toBeNull();
    expect(signOuts).toBe(1);
    expect(takeSignOutNotice()).toBeNull();
  });

  for (const [what, fail] of [
    ["an error", () => Response.json({ error: "boom" }, { status: 500 })],
    [
      "no answer",
      () => {
        throw new TypeError("network down");
      },
    ],
  ] as const) {
    it(`forgets the token on ${what} and says the device may still be listed`, async () => {
      answer = fail;
      await signOutThisDevice();
      expect(await deviceToken()).toBeNull();
      expect(signOuts).toBe(1);
      expect(takeSignOutNotice()).toBe(STILL_LISTED_NOTICE);
      expect(takeSignOutNotice()).toBeNull();
    });
  }

  it("forgets the token when the server never answers", async () => {
    answer = (init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    await signOutThisDevice(50);
    expect(await deviceToken()).toBeNull();
    expect(signOuts).toBe(1);
    expect(takeSignOutNotice()).toBe(STILL_LISTED_NOTICE);
  });

  it("signs out once, though the revocation closes sockets and fails requests meanwhile", async () => {
    answer = async () => {
      // What the revocation's 4401 close does while the request is out.
      signOut();
      return Response.json({ revokedAt: 1 });
    };
    await signOutThisDevice();
    expect(signOuts).toBe(1);
    expect(await deviceToken()).toBeNull();

    // Stragglers after: another socket's 4401 close, a request's 401.
    signOut();
    answer = () => Response.json({ error: "sign in first" }, { status: 401 });
    await serverFetch("/api/devices/me");
    expect(signOuts).toBe(1);
  });
});
