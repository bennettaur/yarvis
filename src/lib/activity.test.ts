import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { waitFor } from "../test/render";
import { resetSidecarApi, stubSidecarApi } from "../test/sidecarApi";
import { type ActivityEvent, subscribeActivity } from "./activity";

afterAll(resetSidecarApi);

const ping = JSON.stringify({ type: "ping" });
const frame = (event: ActivityEvent) => JSON.stringify({ type: "event", event });
const edit: ActivityEvent = {
  origin: "claude",
  type: "edit",
  source: "ws:abcd",
  label: "Edit a.ts",
};

/**
 * Serves one scripted connection per call: its frames, then either the end of
 * the stream or, with `hold`, an open stream that ends only on abort.
 */
function serve(connections: { frames: string[]; hold?: boolean; fail?: boolean }[]) {
  let calls = 0;
  stubSidecarApi({
    streamSSE: async function* (path: string, init: RequestInit = {}) {
      expect(path).toBe("/api/activity/stream");
      const conn = connections[calls++] ?? { frames: [], hold: true };
      if (conn.fail) throw new Error("connection refused");
      for (const data of conn.frames) yield data;
      if (conn.hold) {
        await new Promise<void>((resolve) =>
          init.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
    },
  });
  return { calls: () => calls };
}

describe("subscribeActivity", () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
  });

  function follow(reconnectMs = 5) {
    const events: ActivityEvent[] = [];
    const statuses: boolean[] = [];
    stop = subscribeActivity(
      (e) => events.push(e),
      (s) => statuses.push(s),
      reconnectMs,
    );
    return { events, statuses };
  }

  it("reports connected on the opening ping and passes events on", async () => {
    serve([{ frames: [ping, frame(edit)], hold: true }]);
    const { events, statuses } = follow();
    await waitFor(() => events.length === 1, "the event");
    expect(events[0]).toEqual(edit);
    expect(statuses[0]).toBe(true);
    expect(statuses).not.toContain(false);
  });

  it("skips an unparseable frame and keeps reading", async () => {
    serve([{ frames: [ping, "{not json", frame(edit)], hold: true }]);
    const { events } = follow();
    await waitFor(() => events.length === 1, "the event after the bad frame");
  });

  it("reports a dropped stream and reconnects", async () => {
    const server = serve([
      { frames: [ping] },
      { frames: [], fail: true },
      { frames: [ping, frame(edit)], hold: true },
    ]);
    const { events, statuses } = follow();
    await waitFor(() => events.length === 1, "the event from the third connection");
    expect(server.calls()).toBe(3);
    expect(statuses).toEqual([true, false, false, true, true]);
  });

  it("stops connecting once unsubscribed", async () => {
    const server = serve([{ frames: [ping] }]);
    const { statuses } = follow(20);
    await waitFor(() => statuses.includes(false), "the drop");
    stop?.();
    stop = null;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(server.calls()).toBe(1);
  });
});
