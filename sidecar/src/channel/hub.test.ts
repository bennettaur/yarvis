import { describe, expect, it } from "bun:test";
import { ChannelHub, type RelayIdentity } from "./hub.ts";

const KEY = "ws-claude:11111111-1111-4111-8111-111111111111";

const relay = (overrides: Partial<RelayIdentity> = {}): RelayIdentity => ({
  relayId: crypto.randomUUID(),
  pid: 4242,
  channelEnabled: true,
  ...overrides,
});

/** Starts a poll and ends it at once, leaving the relay as the channel's owner. */
async function pollOnce(hub: ChannelHub, who: RelayIdentity) {
  const controller = new AbortController();
  const poll = hub.next(KEY, who, controller.signal);
  controller.abort();
  return poll;
}

describe("ChannelHub", () => {
  it("refuses a message when no relay has polled, so the caller falls back", () => {
    const hub = new ChannelHub();
    expect(hub.listener(KEY)).toBeNull();
    expect(hub.send(KEY, "hello")).toBeNull();
  });

  it("hands a message straight to a poll that is waiting", async () => {
    const hub = new ChannelHub();
    const who = relay();
    const poll = hub.next(KEY, who);
    expect(hub.listener(KEY)).toEqual(who);
    const sent = hub.send(KEY, "summarize your progress");
    expect(await poll).toEqual([sent!]);
  });

  it("queues a message sent between polls for the owner's next one", async () => {
    let now = 1_000_000;
    const hub = new ChannelHub(() => now);
    const who = relay();
    expect(await pollOnce(hub, who)).toEqual([]);

    now += 1_000;
    const sent = hub.send(KEY, "push the branch");
    expect(sent).not.toBeNull();
    expect(await hub.next(KEY, who)).toEqual([sent!]);
  });

  it("stops counting a relay as live a few seconds after its last poll", async () => {
    let now = 1_000_000;
    const hub = new ChannelHub(() => now);
    await pollOnce(hub, relay());

    now += 10_000;
    expect(hub.listener(KEY)).toBeNull();
    expect(hub.send(KEY, "anyone there?")).toBeNull();
  });

  it("counts a relay as live for the whole of a long poll, past the grace window", async () => {
    let now = 1_000_000;
    const hub = new ChannelHub(() => now);
    const who = relay();
    const poll = hub.next(KEY, who);

    now += 20_000;
    expect(hub.listener(KEY)).toEqual(who);
    const sent = hub.send(KEY, "how far along are you?");
    expect(await poll).toEqual([sent!]);
  });

  it("doesn't hold a poll whose request already ended, so a send isn't lost to it", async () => {
    let now = 1_000_000;
    const hub = new ChannelHub(() => now);
    const who = relay();
    const controller = new AbortController();
    controller.abort();
    expect(await hub.next(KEY, who, controller.signal)).toEqual([]);

    now += 1_000;
    const sent = hub.send(KEY, "still there?");
    expect(await hub.next(KEY, who)).toEqual([sent!]);
  });

  it("refuses a second relay while the first is live, so it can't take the messages", async () => {
    const hub = new ChannelHub();
    const first = relay();
    const poll = hub.next(KEY, first);
    expect(hub.next(KEY, relay({ pid: 9999 }))).toBeNull();
    const sent = hub.send(KEY, "hi");
    expect(await poll).toEqual([sent!]);
  });

  it("lets a new relay take over once the old one has gone quiet, without its stale queue", async () => {
    let now = 1_000_000;
    const hub = new ChannelHub(() => now);
    const old = relay();
    await pollOnce(hub, old);
    hub.send(KEY, "meant for the old session");

    now += 10_000;
    const fresh = relay({ pid: 5151 });
    const controller = new AbortController();
    const poll = hub.next(KEY, fresh, controller.signal);
    expect(poll).not.toBeNull();
    expect(hub.listener(KEY)).toEqual(fresh);
    controller.abort();
    expect(await poll).toEqual([]);
  });

  it("drops a queued message that waited too long", async () => {
    let now = 1_000_000;
    const hub = new ChannelHub(() => now);
    const who = relay();
    await pollOnce(hub, who);
    hub.send(KEY, "old news");

    now += 20_000;
    const controller = new AbortController();
    const poll = hub.next(KEY, who, controller.signal);
    controller.abort();
    expect(await poll).toEqual([]);
  });

  it("falls back once the queue between polls is full", async () => {
    const hub = new ChannelHub();
    await pollOnce(hub, relay());
    for (let i = 0; i < 20; i++) expect(hub.send(KEY, `m${i}`)).not.toBeNull();
    expect(hub.send(KEY, "one too many")).toBeNull();
  });

  it("records a reply only from the owner, and only to a message it was sent", async () => {
    const hub = new ChannelHub();
    const who = relay();
    const poll = hub.next(KEY, who);
    const sent = hub.send(KEY, "what changed?")!;
    await poll;

    expect(hub.recordReply(KEY, who.relayId, crypto.randomUUID(), "unprompted")).toBe(false);
    expect(hub.recordReply(KEY, crypto.randomUUID(), sent.id, "from an impostor")).toBe(false);
    expect(hub.recordReply(KEY, who.relayId, sent.id, "the parser")).toBe(true);
    expect(hub.replies(KEY).map((r) => r.text)).toEqual(["the parser"]);
    expect(hub.replies(KEY, crypto.randomUUID())).toEqual([]);
  });

  it("matches replies only to the last 50 messages it sent", async () => {
    const hub = new ChannelHub();
    const who = relay();
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) {
      const poll = hub.next(KEY, who);
      ids.push(hub.send(KEY, `m${i}`)!.id);
      await poll;
    }
    expect(hub.recordReply(KEY, who.relayId, ids[0]!, "too late")).toBe(false);
    expect(hub.recordReply(KEY, who.relayId, ids[1]!, "still known")).toBe(true);
    expect(hub.recordReply(KEY, who.relayId, ids[50]!, "newest")).toBe(true);
  });

  it("keeps only the latest 50 replies", async () => {
    const hub = new ChannelHub();
    const who = relay();
    const poll = hub.next(KEY, who);
    const sent = hub.send(KEY, "progress?")!;
    await poll;
    for (let i = 0; i < 51; i++) hub.recordReply(KEY, who.relayId, sent.id, `r${i}`);
    const texts = hub.replies(KEY).map((r) => r.text);
    expect(texts).toHaveLength(50);
    expect(texts[0]).toBe("r1");
    expect(texts.at(-1)).toBe("r50");
  });

  it("releases a waiting poll when it forgets the terminal", async () => {
    const hub = new ChannelHub();
    const poll = hub.next(KEY, relay());
    hub.forget(KEY);
    expect(await poll).toEqual([]);
    expect(() => hub.forget("ws-claude:never-seen")).not.toThrow();
  });

  it("forgets a terminal entirely", async () => {
    const hub = new ChannelHub();
    const who = relay();
    const poll = hub.next(KEY, who);
    const sent = hub.send(KEY, "x")!;
    await poll;
    hub.recordReply(KEY, who.relayId, sent.id, "y");

    hub.forget(KEY);
    expect(hub.listener(KEY)).toBeNull();
    expect(hub.replies(KEY)).toEqual([]);
  });
});
