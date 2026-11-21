import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { invoke } from "@tauri-apps/api/core";
import { realCore } from "../test/coreApi";
import { actAsDesktopApp } from "../test/desktopApp";
import { SidecarError } from "./api";
import {
  deviceToken,
  onAuthChange,
  refusedByServer,
  saveDeviceToken,
  serverFetch,
  signOut,
} from "./server";

const { core, LocalOnlyError } = realCore;

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let answer: () => Response = () => new Response(null, { status: 204 });

const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
  url: string | URL | Request,
  init?: RequestInit,
) => {
  calls.push({ url: String(url), init: init ?? {} });
  return answer();
}) as typeof fetch);

beforeEach(() => {
  calls = [];
  answer = () => new Response(null, { status: 204 });
  saveDeviceToken("tok-core");
});
afterAll(() => {
  fetchSpy.mockRestore();
  signOut();
});

describe("serverFetch", () => {
  it("sends the device token as a bearer header", async () => {
    await serverFetch("/api/devices/me");
    expect(calls[0]?.url).toBe("/api/devices/me");
    expect(new Headers(calls[0]?.init.headers).get("Authorization")).toBe("Bearer tok-core");
  });

  it("signs the device out on a 401", async () => {
    const changes: boolean[] = [];
    const off = onAuthChange((signedIn) => changes.push(signedIn));
    answer = () => new Response('{"error":"sign in first"}', { status: 401 });
    await serverFetch("/api/devices/me");
    off();
    expect(changes).toEqual([false]);
    expect(await deviceToken()).toBeNull();
  });
});

describe("refusedByServer", () => {
  it("tells the server's own refusals from failures worth a retry", () => {
    expect([4400, 4401, 4403].map(refusedByServer)).toEqual([true, true, true]);
    expect([1000, 1006, 1011].map(refusedByServer)).toEqual([false, false, false]);
  });
});

describe("core", () => {
  it("posts the command's arguments and returns its JSON", async () => {
    answer = () => Response.json({ colorTheme: "palenight" });
    const result = await core<{ colorTheme: string }>("set_color_theme", { value: "palenight" });
    expect(result).toEqual({ colorTheme: "palenight" });
    expect(calls[0]?.url).toBe("/api/core/set_color_theme");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ value: "palenight" });
  });

  it("resolves undefined on 204", async () => {
    expect(await core("delete_secret", { key: "github_token" })).toBeUndefined();
  });

  it("throws the server's reason with its status", async () => {
    answer = () => Response.json({ error: "value must be at least 1" }, { status: 400 });
    const error = await core("set_max_pty_sessions", { value: 0 }).catch((e) => e);
    expect(error).toBeInstanceOf(SidecarError);
    expect(error.status).toBe(400);
    expect(error.message).toContain("value must be at least 1");
  });

  describe("machine-local commands", () => {
    let restore: (() => void) | null = null;
    afterEach(() => {
      restore?.();
      restore = null;
    });

    it("refuses them in a browser without calling the server", async () => {
      await expect(core("clipboard_history")).rejects.toBeInstanceOf(LocalOnlyError);
      expect(calls).toEqual([]);
    });

    it("sends them to the Tauri bridge inside the app", async () => {
      restore = actAsDesktopApp();
      // Whichever suite's invoke stub is live answers both the same way.
      expect(await core("clipboard_history")).toEqual(await invoke("clipboard_history"));
      expect(calls).toEqual([]);
    });
  });
});
