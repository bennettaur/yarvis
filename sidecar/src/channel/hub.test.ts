import { describe, expect, it } from "bun:test";
import { ChannelHub, POLL_HOLD_MS } from "./hub.ts";

const KEY = "ws-claude:11111111-1111-4111-8111-111111111111";

describe("ChannelHub", () => {
  it("refuses a message when no relay has polled, so the caller falls back", () => {
    const hub = new ChannelHub();
    expect(hub.isConnected(KEY)).toBe(false);
    expect(hub.send(KEY, "hello")).toBeNull();
  });

  it("hands a message straight to a poll that is waiting", async () => {
    const hub = new ChannelHub();
    const poll = hub.next(KEY);
    const sent = hub.send(KEY, "summarize your progress");
    expect(sent?.text).toBe("summarize your progress");
    expect(await poll).toEqual([sent!]);
  });

  it("queues a message sent between polls for the next one", async () => {
    let now = 1_000_000;
    const hub = new ChannelHub(() => now);
    const controller = new AbortController();
    const first = hub.next(KEY, controller.signal);
    controller.abort();
    expect(await first).toEqual([]);

    now += 5_000;
    const sent = hub.send(KEY, "push the branch");
    expect(sent).not.toBeNull();
    expect(await hub.next(KEY)).toEqual([sent!]);
  });

  it("stops counting a relay as connected once it has gone quiet", async () => {
    let now = 1_000_000;
    const hub = new ChannelHub(() => now);
    const controller = new AbortController();
    const poll = hub.next(KEY, controller.signal);
    controller.abort();
    await poll;

    now += POLL_HOLD_MS * 3;
    expect(hub.isConnected(KEY)).toBe(false);
    expect(hub.send(KEY, "anyone there?")).toBeNull();
  });

  it("ends an earlier poll empty when the same terminal polls again", async () => {
    const hub = new ChannelHub();
    const stale = hub.next(KEY);
    const fresh = hub.next(KEY);
    expect(await stale).toEqual([]);
    const sent = hub.send(KEY, "hi");
    expect(await fresh).toEqual([sent!]);
  });

  it("keeps replies per terminal and filters them by message", () => {
    const hub = new ChannelHub();
    hub.reply(KEY, { messageId: "a", text: "first" });
    hub.reply(KEY, { messageId: "b", text: "second" });
    hub.reply("ws-claude:other", { messageId: "a", text: "not this one" });
    expect(hub.replies(KEY).map((r) => r.text)).toEqual(["first", "second"]);
    expect(hub.replies(KEY, "b").map((r) => r.text)).toEqual(["second"]);
  });
});
