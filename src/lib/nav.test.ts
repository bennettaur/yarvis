import { describe, expect, it } from "bun:test";
import {
  type NewWorkspaceRequest,
  type OpenWorkspaceRequest,
  onNewWorkspace,
  onOpenWorkspace,
  requestNewWorkspace,
  requestOpenWorkspace,
} from "./nav";

describe("open-workspace cross-tab bus", () => {
  it("delivers the exact request (including a session to focus) to a subscriber", () => {
    const received: OpenWorkspaceRequest[] = [];
    const off = onOpenWorkspace((r) => received.push(r));
    requestOpenWorkspace({ id: "ws-1", focusSessionKey: "agent" });
    off();
    expect(received).toEqual([{ id: "ws-1", focusSessionKey: "agent" }]);
  });

  it("stops delivering after unsubscribe", () => {
    const received: OpenWorkspaceRequest[] = [];
    const off = onOpenWorkspace((r) => received.push(r));
    off();
    requestOpenWorkspace({ id: "ws-2" });
    expect(received).toEqual([]);
  });
});

describe("new-workspace cross-tab bus", () => {
  it("delivers the task pre-fill (name, taskId, startWork) to a subscriber", () => {
    const received: NewWorkspaceRequest[] = [];
    const off = onNewWorkspace((r) => received.push(r));
    requestNewWorkspace({
      name: "Ship the delete button",
      taskId: "task-1",
      startWork: true,
    });
    off();
    expect(received).toEqual([
      { name: "Ship the delete button", taskId: "task-1", startWork: true },
    ]);
  });

  it("stops delivering after unsubscribe", () => {
    const received: NewWorkspaceRequest[] = [];
    const off = onNewWorkspace((r) => received.push(r));
    off();
    requestNewWorkspace({ name: "later" });
    expect(received).toEqual([]);
  });

  it("does not cross-fire with the open-workspace bus", () => {
    // The two buses share a single EventTarget but are keyed by event name;
    // a subscriber to one must never receive events from the other.
    const openReceived: OpenWorkspaceRequest[] = [];
    const newReceived: NewWorkspaceRequest[] = [];
    const offOpen = onOpenWorkspace((r) => openReceived.push(r));
    const offNew = onNewWorkspace((r) => newReceived.push(r));
    requestOpenWorkspace({ id: "ws-1" });
    requestNewWorkspace({ name: "n" });
    offOpen();
    offNew();
    expect(openReceived).toEqual([{ id: "ws-1" }]);
    expect(newReceived).toEqual([{ name: "n" }]);
  });
});
