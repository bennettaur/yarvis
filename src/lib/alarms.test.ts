import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { nativeInvoke } from "../test/nativeInvoke";
import { resetSidecarApi, stubSidecarApi } from "../test/sidecarApi";

/**
 * The webview stops an alarm ringing before it asks the sidecar to record the
 * user's choice, so the screen and sound are freed even when that request fails.
 */

const invoked: { command: string; args: unknown }[] = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: unknown) => {
    invoked.push({ command, args });
    return nativeInvoke(command);
  },
}));

stubSidecarApi({
  sidecarFetch: async () => {
    throw new Error("sidecar unreachable");
  },
});

// Other suites replace `./alarms` with a fake for the whole run; the query
// string loads the real module whatever ran first.
const realAlarms = "./alarms.ts?release-test";
const { acknowledgeAlarm, snoozeAlarm } = (await import(realAlarms)) as typeof import("./alarms");

afterEach(() => {
  invoked.length = 0;
});

// `mock.module` lasts for the whole run, so hand later suites the real modules back.
afterAll(() => {
  resetSidecarApi();
  mock.module("@tauri-apps/api/core", () => ({ invoke: nativeInvoke }));
});

describe("dealing with a ringing alarm", () => {
  it("stops the ringing even when the sidecar can't record it", async () => {
    await expect(acknowledgeAlarm("a1")).rejects.toThrow("sidecar unreachable");
    await expect(snoozeAlarm("a2", 5)).rejects.toThrow("sidecar unreachable");

    expect(invoked).toEqual([
      { command: "release_alarm", args: { id: "a1" } },
      { command: "release_alarm", args: { id: "a2" } },
    ]);
  });
});
