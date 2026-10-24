import { afterEach, describe, expect, it, mock } from "bun:test";
import { nativeInvoke } from "../test/nativeInvoke";
import * as realApi from "./api";

/**
 * The webview stops an alarm ringing before it asks the sidecar to record the
 * user's choice, so the screen and sound are freed even when that request fails.
 */

const invoked: { command: string; args: unknown }[] = [];
let sidecarDown = false;

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: unknown) => {
    invoked.push({ command, args });
    return nativeInvoke(command);
  },
}));

mock.module("./api", () => ({
  ...realApi,
  sidecarFetch: async (path: string, init?: RequestInit) => {
    if (sidecarDown) throw new Error("sidecar unreachable");
    return realApi.sidecarFetch(path, init);
  },
}));

// Other suites replace `./alarms` with a fake for the whole run; the query
// string loads the real module whatever ran first.
const realAlarms = "./alarms.ts?release-test";
const { acknowledgeAlarm, snoozeAlarm } = (await import(realAlarms)) as typeof import("./alarms");

afterEach(() => {
  invoked.length = 0;
  sidecarDown = false;
});

describe("dealing with a ringing alarm", () => {
  it("stops the ringing even when the sidecar can't record it", async () => {
    sidecarDown = true;

    await expect(acknowledgeAlarm("a1")).rejects.toThrow("sidecar unreachable");
    await expect(snoozeAlarm("a2", 5)).rejects.toThrow("sidecar unreachable");

    expect(invoked).toEqual([
      { command: "release_alarm", args: { id: "a1" } },
      { command: "release_alarm", args: { id: "a2" } },
    ]);
  });
});
