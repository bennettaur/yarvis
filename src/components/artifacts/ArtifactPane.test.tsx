import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mountForInteraction, waitFor } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";
import ArtifactPane from "./ArtifactPane";

afterAll(resetSidecarApi);

const ID = "6f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const OTHER = "0b8f3c1e-2d4a-4e6b-9c7d-1a2b3c4d5e6f";

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    title: "Launch plan",
    format: "markdown",
    content: `See [the diagram](yarvis://artifact/${OTHER}).`,
    createdBy: "chat",
    untrusted: false,
    createdAt: "2026-11-02T10:00:00Z",
    updatedAt: "2026-11-02T10:00:00Z",
    ...overrides,
  };
}

/**
 * Serves the artifact from `read` on each GET, and pushes stream frames the
 * test sends with `push`. Counts the reads so a test can see them coalesce.
 * `delivered` is true once the pane has taken every pushed frame.
 */
function serve(read: () => Promise<unknown>) {
  let reads = 0;
  let delivered = false;
  let push: ((frame: string) => void) | null = null;
  stubSidecarApi({
    sidecarFetch: async (path: string) => {
      expect(path).toBe(`/api/artifacts/${ID}`);
      reads += 1;
      const body = await read();
      return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
    },
    streamSSE: async function* (_path: string, init: RequestInit = {}) {
      const queue: string[] = [JSON.stringify({ type: "ping" })];
      let wake: (() => void) | null = null;
      push = (frame) => {
        delivered = false;
        queue.push(frame);
        wake?.();
      };
      while (!init.signal?.aborted) {
        while (queue.length > 0) yield queue.shift() as string;
        delivered = true;
        await new Promise<void>((resolve) => {
          wake = resolve;
          init.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
  });
  return {
    reads: () => reads,
    delivered: () => delivered,
    push: (type: string) => push?.(JSON.stringify({ type })),
  };
}

describe("ArtifactPane", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  async function mount() {
    const { host, unmount } = await mountForInteraction(
      <ArtifactPane id={ID} onClose={() => {}} />,
    );
    cleanup = unmount;
    return host;
  }

  it("keeps in-app links in an artifact the user's chat wrote", async () => {
    serve(async () => artifact());
    const host = await mount();
    await waitFor(() => host.textContent?.includes("Launch plan") ?? false, "the artifact");
    expect(host.querySelector("a")?.getAttribute("href")).toBe(`yarvis://artifact/${OTHER}`);
  });

  it("drops in-app links from an untrusted artifact, and badges it", async () => {
    serve(async () => artifact({ untrusted: true }));
    const host = await mount();
    await waitFor(() => host.textContent?.includes("untrusted") ?? false, "the badge");
    expect(host.innerHTML).not.toContain("yarvis://artifact/");
  });

  it("says so when the artifact is deleted while open", async () => {
    const server = serve(async () => artifact());
    const host = await mount();
    await waitFor(() => host.textContent?.includes("Launch plan") ?? false, "the artifact");
    server.push("deleted");
    await waitFor(
      () => host.textContent?.includes("This artifact was deleted.") ?? false,
      "the deleted note",
    );
  });

  it("says so when a re-read finds it gone, since the delete's signal can be missed", async () => {
    let gone = false;
    const server = serve(async () => (gone ? new Response("{}", { status: 404 }) : artifact()));
    const host = await mount();
    await waitFor(() => host.textContent?.includes("Launch plan") ?? false, "the artifact");
    gone = true;
    server.push("updated");
    await waitFor(
      () => host.textContent?.includes("This artifact was deleted.") ?? false,
      "the deleted note",
    );
  });

  it("keeps the last read on screen, with the error, when a re-read fails", async () => {
    let failing = false;
    const server = serve(async () =>
      failing ? new Response("{}", { status: 500 }) : artifact({ content: "Still here" }),
    );
    const host = await mount();
    await waitFor(() => host.textContent?.includes("Still here") ?? false, "the artifact");
    // The first read, then one more for the stream connecting.
    await waitFor(() => server.reads() === 2, "the stream's first re-read");
    failing = true;
    server.push("updated");
    await waitFor(() => host.querySelector('[role="alert"]') !== null, "the error");
    expect(host.textContent).toContain("Still here");
  });

  it("reads once more, not once per change, for a burst during a slow read", async () => {
    let release: (() => void) | null = null;
    let version = 0;
    const server = serve(async () => {
      version += 1;
      if (version === 3) await new Promise<void>((r) => (release = r));
      return artifact({ content: `version ${version}` });
    });
    const host = await mount();
    // The first read, then one more for the stream connecting.
    await waitFor(() => host.textContent?.includes("version 2") ?? false, "the first reads");

    server.push("updated");
    await waitFor(() => release !== null, "the slow second read");
    server.push("updated");
    server.push("updated");
    server.push("updated");
    await waitFor(server.delivered, "the burst reaching the pane");
    (release as (() => void) | null)?.();

    await waitFor(() => host.textContent?.includes("version 4") ?? false, "the final read");
    await new Promise((r) => setTimeout(r, 30));
    expect(server.reads()).toBe(4);
  });
});
