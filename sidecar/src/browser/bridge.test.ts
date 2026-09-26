import { describe, expect, it } from "bun:test";
import {
  BrowserBridge,
  BrowserNotConnectedError,
  type PollResult,
  type QueuedCommand,
} from "./bridge.ts";

/** The command type a poll handed out, or null if it handed out nothing. */
function commandType(poll: PollResult): string | null {
  return poll && poll !== "superseded" ? poll.command.type : null;
}

function collected(poll: PollResult): QueuedCommand {
  if (!poll || poll === "superseded") throw new Error("expected a command");
  return poll;
}

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

    const item = collected(await poll);
    expect(item.command).toEqual({ type: "list_tabs" });
    expect(bridge.complete(item.id, { ok: true, data: [] })).toBe(true);
    expect(await answer).toEqual({ ok: true, data: [] });
  });

  it("holds a command for the next poll when none is waiting", async () => {
    const bridge = new BrowserBridge("t");
    await bridge.next(1); // marks the extension connected, then expires
    const answer = bridge.request({ type: "read_page", maxChars: 500 });

    const item = collected(await bridge.next(1000));
    expect(item.command.type).toBe("read_page");
    bridge.complete(item.id, { ok: false, error: "nope" });
    expect(await answer).toEqual({ ok: false, error: "nope" });
  });

  it("times out a command nobody answers and ignores the late reply", async () => {
    const bridge = new BrowserBridge("t");
    await bridge.next(1);
    const answer = bridge.request({ type: "list_tabs" }, 20);
    const item = collected(await bridge.next(1000));

    expect(await answer).toEqual({ ok: false, error: "The browser did not answer in time." });
    expect(bridge.complete(item.id, { ok: true })).toBe(false);
  });

  it("drops a timed-out command that was never collected", async () => {
    const bridge = new BrowserBridge("t");
    await bridge.next(1);
    expect(await bridge.request({ type: "list_tabs" }, 10)).toMatchObject({ ok: false });
    // A stale command must not be handed to the next poll.
    expect(await bridge.next(20)).toBeNull();
  });

  it("serves queued commands in order", async () => {
    const bridge = new BrowserBridge("t");
    await bridge.next(1);
    void bridge.request({ type: "list_tabs" });
    void bridge.request({ type: "read_page", maxChars: 500 });
    expect(commandType(await bridge.next(20))).toBe("list_tabs");
    expect(commandType(await bridge.next(20))).toBe("read_page");
  });

  it("lets a newer poll supersede an older one", async () => {
    const bridge = new BrowserBridge("t");
    const first = bridge.next(1000);
    const second = bridge.next(1000);
    expect(await first).toBe("superseded");

    const answer = bridge.request({ type: "list_tabs" });
    const item = await second;
    if (item === "superseded" || item === null) throw new Error("expected a command");
    expect(item.command.type).toBe("list_tabs");
    bridge.complete(item.id, { ok: true, data: 1 });
    expect(await answer).toEqual({ ok: true, data: 1 });
  });

  it("ends a poll early when the client goes away", async () => {
    const bridge = new BrowserBridge("t");
    const controller = new AbortController();
    const poll = bridge.next(10_000, controller.signal);
    controller.abort();
    expect(await poll).toBeNull();
  });
});
