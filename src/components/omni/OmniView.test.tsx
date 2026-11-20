import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mountForInteraction } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";
import OmniView from "./OmniView";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

stubSidecarApi({
  sidecarFetch: async (path: string) => {
    if (path.startsWith("/api/chat/providers"))
      return json([
        {
          id: "anthropic",
          label: "Anthropic",
          models: [{ id: "claude-sonnet-5", capabilities: ["chat"] }],
          available: true,
        },
      ]);
    if (path === "/api/omni/layouts") return json([]);
    return new Response("unexpected request", { status: 404 });
  },
});

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  localStorage.clear();
});
afterAll(() => resetSidecarApi());

async function mount() {
  const mounted = await mountForInteraction(<OmniView />);
  cleanup = mounted.unmount;
  return mounted.host;
}

describe("OmniView builder thread", () => {
  it("says there is no layout yet before the first request", async () => {
    const host = await mount();
    expect(host.querySelector('[role="log"]')?.textContent).toContain("No layout yet");
  });

  it("shows the saved turns in order, in the scrolling thread, labelled like the chat's", async () => {
    localStorage.setItem(
      "yarvis.omni.messages",
      JSON.stringify([
        { role: "user", content: "Build me a focus board" },
        { role: "assistant", content: "Here's a focus board" },
      ]),
    );
    const host = await mount();
    const thread = host.querySelector('[role="log"]');
    expect(thread?.textContent).not.toContain("No layout yet");
    const turns = Array.from(thread?.querySelectorAll(".is-user, .is-assistant") ?? []).map(
      (turn) => turn.textContent,
    );
    expect(turns).toEqual(["userBuild me a focus board", "assistantHere's a focus board"]);
  });
});
