import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { fakeSockets, installFakeSockets } from "../test/fakeSocket";
import { waitFor } from "../test/render";
import { deviceToken, saveDeviceToken, signOut } from "./server";
import { onServerEvent, type ServerEvent } from "./serverEvents";

let restore: () => void;
beforeAll(() => {
  restore = installFakeSockets();
  saveDeviceToken("tok-1");
});
afterAll(() => {
  signOut();
  restore();
});

const unsubscribers: (() => void)[] = [];
afterEach(() => {
  for (const off of unsubscribers.splice(0)) off();
});

const event = (seq: number, kind: string, data: unknown = {}) => ({
  type: "event",
  seq,
  at: "2026-11-20T10:00:00Z",
  deviceId: null,
  kind,
  data,
});

describe("onServerEvent", () => {
  it("authenticates first, then hands each subscriber only its kind", async () => {
    const alarms: ServerEvent[] = [];
    const all: ServerEvent[] = [];
    unsubscribers.push(onServerEvent("alarm.fire", (e) => alarms.push(e)));
    unsubscribers.push(onServerEvent("*", (e) => all.push(e)));

    await waitFor(() => fakeSockets().length === 1);
    const socket = fakeSockets()[0];
    expect(socket?.url).toBe("ws://yarvis.test/api/events");
    socket?.open();
    expect(socket?.sent[0]).toMatchObject({ type: "auth", token: "tok-1" });

    socket?.sendJson(event(1, "alarm.fire", { id: "a1" }));
    socket?.sendJson(event(2, "device.created"));
    expect(alarms.map((e) => e.data)).toEqual([{ id: "a1" }]);
    expect(all.map((e) => e.kind)).toEqual(["alarm.fire", "device.created"]);
  });

  it("reconnects after a drop, asking for what it missed, and skips repeats", async () => {
    const seen: number[] = [];
    const before = fakeSockets().length;
    unsubscribers.push(onServerEvent("*", (e) => seen.push(e.seq)));
    await waitFor(() => fakeSockets().length === before + 1);
    const first = fakeSockets()[before];
    first?.open();
    first?.sendJson(event(10, "sidecar.started"));
    first?.serverClose(1006);

    await waitFor(() => fakeSockets().length === before + 2, "the reconnect", 3_000);
    const second = fakeSockets()[before + 1];
    second?.open();
    expect(second?.sent[0]).toEqual({ type: "auth", token: "tok-1", since: 10 });
    second?.sendJson(event(10, "sidecar.started"));
    second?.sendJson(event(11, "sidecar.stopped"));
    expect(seen).toEqual([10, 11]);
  });

  it("reloads cached data after falling behind, and starts the next connection from now", async () => {
    const { cachedFetch, resourceCacheSize } = await import("./resourceCache");
    await cachedFetch("probe", async () => "cached");
    expect(resourceCacheSize()).toBe(1);
    const before = fakeSockets().length;
    unsubscribers.push(onServerEvent("*", () => {}));
    await waitFor(() => fakeSockets().length === before + 1, "the socket");
    const first = fakeSockets()[before];
    first?.open();
    first?.sendJson(event(50, "sidecar.started"));
    first?.sendJson({ type: "lagged" });
    first?.serverClose(1000);

    expect(resourceCacheSize()).toBe(0);
    await waitFor(() => fakeSockets().length === before + 2, "the reconnect", 3_000);
    const second = fakeSockets()[before + 1];
    second?.open();
    expect(second?.sent[0]).toEqual({ type: "auth", token: "tok-1" });
  });

  it("signs the device out when the server refuses the token", async () => {
    const before = fakeSockets().length;
    unsubscribers.push(onServerEvent("*", () => {}));
    await waitFor(() => fakeSockets().length === before + 1);
    const socket = fakeSockets()[before];
    socket?.open();
    socket?.serverClose(4401, "sign in first");
    expect(await deviceToken()).toBeNull();
    saveDeviceToken("tok-1");
  });
});
