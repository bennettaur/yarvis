import { describe, expect, it } from "bun:test";
import {
  BrowserBridge,
  BrowserNotConnectedError,
  type PollResult,
  type QueuedCommand,
} from "./bridge.ts";

const work = { id: "id-work", name: "work" };
const home = { id: "id-home", name: "Personal" };

function collected(poll: PollResult): QueuedCommand {
  if (!poll || poll === "superseded") throw new Error("expected a command");
  return poll;
}

/** The command type a poll handed out, or null if it handed out nothing. */
function commandType(poll: PollResult): string | null {
  return poll && poll !== "superseded" ? poll.command.type : null;
}

describe("BrowserBridge", () => {
  it("refuses a request while no profile has polled", async () => {
    const bridge = new BrowserBridge("t");
    await expect(bridge.request({ type: "list_tabs" })).rejects.toBeInstanceOf(
      BrowserNotConnectedError,
    );
  });

  it("hands a queued command to a polling profile and returns its answer", async () => {
    const bridge = new BrowserBridge("t");
    const poll = bridge.next(work, 1000);
    const answer = bridge.request({ type: "list_tabs" });

    const item = collected(await poll);
    expect(item.command).toEqual({ type: "list_tabs" });
    expect(bridge.complete(item.id, { ok: true, data: [] })).toBe(true);
    expect(await answer).toEqual({ ok: true, data: [] });
  });

  it("holds a command for the next poll when none is waiting", async () => {
    const bridge = new BrowserBridge("t");
    await bridge.next(work, 1);
    const answer = bridge.request({ type: "read_page", maxChars: 500 });

    const item = collected(await bridge.next(work, 1000));
    expect(item.command.type).toBe("read_page");
    bridge.complete(item.id, { ok: false, error: "nope" });
    expect(await answer).toEqual({ ok: false, error: "nope" });
  });

  it("times out a command nobody answers and ignores the late reply", async () => {
    const bridge = new BrowserBridge("t");
    await bridge.next(work, 1);
    const answer = bridge.request({ type: "list_tabs" }, { timeoutMs: 20 });
    const item = collected(await bridge.next(work, 1000));

    expect(await answer).toEqual({ ok: false, error: "The browser did not answer in time." });
    expect(bridge.complete(item.id, { ok: true })).toBe(false);
  });

  it("drops a timed-out command that was never collected", async () => {
    const bridge = new BrowserBridge("t");
    await bridge.next(work, 1);
    expect(await bridge.request({ type: "list_tabs" }, { timeoutMs: 10 })).toMatchObject({
      ok: false,
    });
    expect(await bridge.next(work, 20)).toBeNull();
  });

  it("serves queued commands in order", async () => {
    const bridge = new BrowserBridge("t");
    await bridge.next(work, 1);
    void bridge.request({ type: "list_tabs" });
    void bridge.request({ type: "read_page", maxChars: 500 });
    expect(commandType(await bridge.next(work, 20))).toBe("list_tabs");
    expect(commandType(await bridge.next(work, 20))).toBe("read_page");
  });

  it("lets a newer poll from the same profile supersede an older one", async () => {
    const bridge = new BrowserBridge("t");
    const first = bridge.next(work, 1000);
    const second = bridge.next(work, 1000);
    expect(await first).toBe("superseded");

    const answer = bridge.request({ type: "list_tabs" });
    const item = collected(await second);
    bridge.complete(item.id, { ok: true, data: 1 });
    expect(await answer).toEqual({ ok: true, data: 1 });
  });

  it("ends a poll early when the client goes away", async () => {
    const bridge = new BrowserBridge("t");
    const controller = new AbortController();
    const poll = bridge.next(work, 10_000, controller.signal);
    controller.abort();
    expect(await poll).toBeNull();
  });

  describe("with several Chrome profiles", () => {
    it("keeps each profile's polls apart", async () => {
      const bridge = new BrowserBridge("t");
      const workPoll = bridge.next(work, 1000);
      const homePoll = bridge.next(home, 30);
      // Neither supersedes the other.
      expect(await homePoll).toBeNull();

      const answer = bridge.request({ type: "list_tabs" }, { profile: "work" });
      const item = collected(await workPoll);
      bridge.complete(item.id, { ok: true, data: "from work" });
      expect(await answer).toEqual({ ok: true, data: "from work" });
    });

    it("asks which profile when none is named", async () => {
      const bridge = new BrowserBridge("t");
      await bridge.next(work, 1);
      await bridge.next(home, 1);
      await expect(bridge.request({ type: "list_tabs" })).rejects.toThrow(
        "Several Chrome profiles are connected (work, Personal)",
      );
    });

    it("finds a profile by name, ignoring case, or by id", async () => {
      const bridge = new BrowserBridge("t");
      await bridge.next(work, 1);
      await bridge.next(home, 1);

      const byName = bridge.request({ type: "list_tabs" }, { profile: "personal" });
      expect(commandType(await bridge.next(home, 20))).toBe("list_tabs");
      const byId = bridge.request({ type: "list_tabs" }, { profile: "id-work" });
      expect(commandType(await bridge.next(work, 20))).toBe("list_tabs");
      void byName;
      void byId;
    });

    it("names the connected profiles when the one asked for isn't there", async () => {
      const bridge = new BrowserBridge("t");
      await bridge.next(work, 1);
      await expect(bridge.request({ type: "list_tabs" }, { profile: "school" })).rejects.toThrow(
        'No connected Chrome profile is called "school". Connected: work.',
      );
    });

    it("follows a rename, since the id is what identifies the profile", async () => {
      const bridge = new BrowserBridge("t");
      await bridge.next(work, 1);
      await bridge.next({ id: work.id, name: "office" }, 1);
      expect(bridge.profiles()).toEqual([{ id: "id-work", name: "office" }]);
    });
  });
});
