import { afterEach, describe, expect, it } from "bun:test";
import type { PendingApproval } from "../lib/chat";
import { mountForInteraction, renderToHtml, textOf } from "../test/render";
import ToolApprovalBar from "./ToolApprovalBar";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: "call-1",
    toolId: "mcp:server-uuid:search_pages",
    name: "search_pages",
    server: "Notion",
    args: { query: "roadmap" },
    ...overrides,
  };
}

function click(host: HTMLElement, label: string) {
  const button = Array.from(host.querySelectorAll("button")).find((b) =>
    b.textContent?.startsWith(label),
  );
  button?.click();
}

describe("ToolApprovalBar", () => {
  it("renders nothing with no pending calls", async () => {
    expect(await renderToHtml(<ToolApprovalBar approvals={[]} onRespond={() => {}} />)).toBe("");
  });

  it("shows the front of the queue and how many are behind it", async () => {
    const html = await renderToHtml(
      <ToolApprovalBar
        approvals={[approval(), approval({ id: "call-2", name: "write_page" })]}
        onRespond={() => {}}
      />,
    );
    const text = textOf(html);
    expect(text).toContain("search_pages");
    expect(text).toContain("on Notion");
    expect(text).toContain("+1 waiting");
    // The thread stays readable: arguments are behind a disclosure.
    expect(text).not.toContain("roadmap");
  });

  it("answers the front of the queue", async () => {
    const answered: Array<[string, boolean]> = [];
    const mounted = await mountForInteraction(
      <ToolApprovalBar
        approvals={[approval(), approval({ id: "call-2" })]}
        onRespond={(id, ok) => answered.push([id, ok])}
      />,
    );
    cleanup = mounted.unmount;

    click(mounted.host, "Approve");
    click(mounted.host, "Deny");
    expect(answered).toEqual([
      ["call-1", true],
      ["call-1", false],
    ]);
  });

  it("approves with A and denies with D", async () => {
    const answered: Array<[string, boolean]> = [];
    const mounted = await mountForInteraction(
      <ToolApprovalBar approvals={[approval()]} onRespond={(id, ok) => answered.push([id, ok])} />,
    );
    cleanup = mounted.unmount;

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "D", bubbles: true }));
    expect(answered).toEqual([
      ["call-1", true],
      ["call-1", false],
    ]);
  });

  it("ignores those keys while the user is typing", async () => {
    const answered: Array<[string, boolean]> = [];
    const mounted = await mountForInteraction(
      <ToolApprovalBar approvals={[approval()]} onRespond={(id, ok) => answered.push([id, ok])} />,
    );
    cleanup = mounted.unmount;

    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    composer.remove();
    expect(answered).toEqual([]);
  });

  it("offers to remember an MCP tool, but not a built-in", async () => {
    const remembered: string[] = [];
    const mounted = await mountForInteraction(
      <ToolApprovalBar
        approvals={[approval()]}
        onRespond={() => {}}
        onAlwaysAllow={(a) => remembered.push(a.id)}
      />,
    );
    cleanup = mounted.unmount;
    click(mounted.host, "Always allow");
    expect(remembered).toEqual(["call-1"]);

    const builtin = await renderToHtml(
      <ToolApprovalBar
        approvals={[approval({ toolId: undefined, server: "" })]}
        onRespond={() => {}}
        onAlwaysAllow={() => {}}
      />,
    );
    expect(textOf(builtin)).not.toContain("Always allow");
  });
});
