import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { waitFor } from "../test/render";
import { resetSidecarApi, stubSidecarApi } from "../test/sidecarApi";
import { SidecarError } from "./api";
import { subscribeArtifact } from "./artifacts";

afterAll(resetSidecarApi);

const ID = "6f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const frame = (type: string) => JSON.stringify({ type });

/** One scripted connection per call; `hold` keeps it open until abort. */
function serve(connections: { frames: string[]; hold?: boolean }[]) {
  let calls = 0;
  stubSidecarApi({
    streamSSE: async function* (path: string, init: RequestInit = {}) {
      expect(path).toBe(`/api/artifacts/${ID}/stream`);
      const conn = connections[calls++] ?? { frames: [], hold: true };
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

describe("subscribeArtifact", () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
  });

  function follow() {
    const seen: string[] = [];
    stop = subscribeArtifact(
      ID,
      { onChange: () => seen.push("change"), onDeleted: () => seen.push("deleted") },
      5,
    );
    return seen;
  }

  it("signals each update, and once when it connects, but not each heartbeat", async () => {
    serve([
      { frames: [frame("ping"), frame("updated"), frame("ping"), frame("updated")], hold: true },
    ]);
    const seen = follow();
    await waitFor(() => seen.length === 3, "the connect and two changes");
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["change", "change", "change"]);
  });

  it("signals a change once on each connect, since a write may have landed before it", async () => {
    const server = serve([
      { frames: [frame("ping")] },
      { frames: [frame("ping"), frame("ping")], hold: true },
    ]);
    const seen = follow();
    await waitFor(() => server.calls() === 2 && seen.length === 2, "the reconnect");
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["change", "change"]);
  });

  it("skips an unparseable frame and keeps following", async () => {
    serve([{ frames: [frame("ping"), "not json", frame("updated")], hold: true }]);
    const seen = follow();
    await waitFor(() => seen.length === 2, "the change after the bad frame");
  });

  it("stops for good once the artifact is deleted", async () => {
    const server = serve([{ frames: [frame("ping"), frame("deleted")] }]);
    const seen = follow();
    await waitFor(() => seen.includes("deleted"), "the delete");
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual(["change", "deleted"]);
    expect(server.calls()).toBe(1);
  });

  it("counts a stream the sidecar refuses as the artifact gone, and stops", async () => {
    let calls = 0;
    stubSidecarApi({
      streamSSE: async function* () {
        calls += 1;
        yield* [];
        throw new SidecarError("stream → 404", 404);
      },
    });
    const seen = follow();
    await waitFor(() => seen.includes("deleted"), "the delete");
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual(["deleted"]);
    expect(calls).toBe(1);
  });

  it("stops reconnecting once unsubscribed", async () => {
    const server = serve([{ frames: [frame("ping")] }, { frames: [frame("ping")] }]);
    follow();
    await waitFor(() => server.calls() >= 1, "the first connection");
    stop?.();
    stop = null;
    const calls = server.calls();
    await new Promise((r) => setTimeout(r, 30));
    expect(server.calls()).toBe(calls);
  });
});
