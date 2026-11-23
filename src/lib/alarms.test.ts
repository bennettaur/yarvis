import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { actAsDesktopApp } from "../test/desktopApp";
import { fakeSockets, installFakeSockets } from "../test/fakeSocket";
import { nativeInvoke } from "../test/nativeInvoke";
import { waitFor } from "../test/render";
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
const { acknowledgeAlarm, onAlarmFired, onAlarmReleased, snoozeAlarm } = (await import(
  realAlarms
)) as typeof import("./alarms");
const { saveDeviceToken, signOut } = await import("./server");

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

describe("alarm events from the server", () => {
  it("rings and silences the alarm on this machine inside the desktop app", async () => {
    const restoreSockets = installFakeSockets();
    const restoreBrowser = actAsDesktopApp();
    saveDeviceToken("tok-alarms");
    try {
      const fired: string[] = [];
      const released: string[] = [];
      const offFired = await onAlarmFired((a) => fired.push(a.id));
      const offReleased = await onAlarmReleased((a) => released.push(a.id));
      await waitFor(() => fakeSockets().length > 0, "the events socket");
      const socket = fakeSockets()[0];
      socket?.open();
      const alarm = {
        id: "a9",
        label: "Standup",
        fireAtMs: 1,
        sound: true,
        meetLink: null,
        status: "fired",
      };
      socket?.sendJson({
        type: "event",
        seq: 1,
        at: 1,
        deviceId: null,
        kind: "alarm.fire",
        data: alarm,
      });
      socket?.sendJson({
        type: "event",
        seq: 2,
        at: 2,
        deviceId: null,
        kind: "alarm.release",
        data: alarm,
      });
      offFired();
      offReleased();

      expect(fired).toEqual(["a9"]);
      expect(released).toEqual(["a9"]);
      await waitFor(() => invoked.length === 2, "both native calls");
      expect(invoked).toEqual([
        { command: "fire_alarm", args: { alarm } },
        { command: "release_alarm", args: { id: "a9" } },
      ]);
    } finally {
      signOut();
      restoreBrowser();
      restoreSockets();
    }
  });
});
