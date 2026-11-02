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
 */
function serve(read: () => Promise<unknown>) {
  let reads = 0;
  let push: ((frame: string) => void) | null = null;
  stubSidecarApi({
    sidecarFetch: async (path: string) => {
      expect(path).toBe(`/api/artifacts/${ID}`);
      reads += 1;
      return new Response(JSON.stringify(await read()), { status: 200 });
    },
    streamSSE: async function* (_path: string, init: RequestInit = {}) {
      const queue: string[] = [JSON.stringify({ type: "ping" })];
      let wake: (() => void) | null = null;
      push = (frame) => {
        queue.push(frame);
        wake?.();
      };
      while (!init.signal?.aborted) {
        while (queue.length > 0) yield queue.shift() as string;
        await new Promise<void>((resolve) => {
          wake = resolve;
          init.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
  });
  return {
    reads: () => reads,
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

  it("reads once more, not once per change, for a burst during a slow read", async () => {
    let release: (() => void) | null = null;
    let version = 0;
    const server = serve(async () => {
      version += 1;
      if (version === 2) await new Promise<void>((r) => (release = r));
      return artifact({ content: `version ${version}` });
    });
    const host = await mount();
    await waitFor(() => host.textContent?.includes("version 1") ?? false, "the first read");

    server.push("updated");
    await waitFor(() => release !== null, "the slow second read");
    server.push("updated");
    server.push("updated");
    server.push("updated");
    await new Promise((r) => setTimeout(r, 20));
    (release as (() => void) | null)?.();

    await waitFor(() => host.textContent?.includes("version 3") ?? false, "the final read");
    await new Promise((r) => setTimeout(r, 30));
    expect(server.reads()).toBe(3);
  });
});
