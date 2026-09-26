import { describe, expect, it } from "bun:test";
import { BrowserBridge, BrowserNotConnectedError } from "./bridge.ts";

describe("BrowserBridge", () => {
  it("refuses a request while no extension has polled", async () => {
    const bridge = new BrowserBridge("t");
    await expect(bridge.request({ type: "list_tabs" })).rejects.toBeInstanceOf(
      BrowserNotConnectedError,
    );
  });

  it("hands a queued command to a polling extension and returns its answer", async () => {
    const bridge = new BrowserBridge("t");
    const poll = bridge.next(1000);
    const answer = bridge.request({ type: "list_tabs" });

    const item = await poll;
    expect(item?.command).toEqual({ type: "list_tabs" });
    expect(bridge.complete(item?.id as string, { ok: true, data: [] })).toBe(true);
    expect(await answer).toEqual({ ok: true, data: [] });
  });

  it("holds a command for the next poll when none is waiting", async () => {
    const bridge = new BrowserBridge("t");
    await bridge.next(1); // marks the extension connected, then expires
    const answer = bridge.request({ type: "read_page", maxChars: 500 });

    const item = await bridge.next(1000);
    expect(item?.command.type).toBe("read_page");
    bridge.complete(item?.id as string, { ok: false, error: "nope" });
    expect(await answer).toEqual({ ok: false, error: "nope" });
  });

  it("times out a command nobody answers and ignores the late reply", async () => {
    const bridge = new BrowserBridge("t");
    await bridge.next(1);
    const answer = bridge.request({ type: "list_tabs" }, 20);
    const item = await bridge.next(1000);

    expect(await answer).toEqual({ ok: false, error: "The browser did not answer in time." });
    expect(bridge.complete(item?.id as string, { ok: true })).toBe(false);
  });

  it("lets a newer poll supersede an older one", async () => {
    const bridge = new BrowserBridge("t");
    const first = bridge.next(1000);
    const second = bridge.next(1000);
    expect(await first).toBeNull();

    const answer = bridge.request({ type: "list_tabs" });
    expect((await second)?.command.type).toBe("list_tabs");
    void answer;
  });

  it("ends a poll early when the client goes away", async () => {
    const bridge = new BrowserBridge("t");
    const controller = new AbortController();
    const poll = bridge.next(10_000, controller.signal);
    controller.abort();
    expect(await poll).toBeNull();
  });
});
