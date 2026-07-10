import { describe, expect, it } from "bun:test";
import { type OpenWorkspaceRequest, onOpenWorkspace, requestOpenWorkspace } from "./nav";

describe("open-workspace cross-tab bus", () => {
  it("delivers the exact request (including claudePrompt) to a subscriber", () => {
    const received: OpenWorkspaceRequest[] = [];
    const off = onOpenWorkspace((r) => received.push(r));
    requestOpenWorkspace({ id: "ws-1", claudePrompt: "implement the ticket" });
    off();
    expect(received).toEqual([{ id: "ws-1", claudePrompt: "implement the ticket" }]);
  });

  it("stops delivering after unsubscribe", () => {
    const received: OpenWorkspaceRequest[] = [];
    const off = onOpenWorkspace((r) => received.push(r));
    off();
    requestOpenWorkspace({ id: "ws-2" });
    expect(received).toEqual([]);
  });
});
