import { describe, expect, it } from "bun:test";
import type { AzureBoardsClient } from "./client.ts";
import { applyBoardsStartWorkSideEffects, pickStartWorkState } from "./service.ts";
import type { BoardsState } from "./types.ts";

const agile: BoardsState[] = [
  { name: "New", category: "todo" },
  { name: "Active", category: "in_progress" },
  { name: "Resolved", category: "done" },
  { name: "Closed", category: "done" },
];

describe("pickStartWorkState", () => {
  it("prefers a state named In Progress over other in-progress states", () => {
    const states: BoardsState[] = [
      { name: "Blocked", category: "in_progress" },
      { name: "In Progress", category: "in_progress" },
    ];
    expect(pickStartWorkState(states)?.name).toBe("In Progress");
  });

  it("picks Active in the Agile process", () => {
    expect(pickStartWorkState(agile)?.name).toBe("Active");
  });

  it("uses the requested state when the type allows it, and nothing otherwise", () => {
    expect(pickStartWorkState(agile, "Resolved")?.name).toBe("Resolved");
    expect(pickStartWorkState(agile, "Doing")).toBeNull();
  });

  it("returns null when no state is in progress", () => {
    expect(pickStartWorkState([{ name: "To Do", category: "todo" }])).toBeNull();
  });
});

/** A client stub that records the writes start-work makes. */
function stubClient(overrides: Partial<Record<keyof AzureBoardsClient, unknown>> = {}) {
  const calls: string[] = [];
  const client = {
    viewer: async () => ({ login: "Jane", uniqueName: "jane@acme.com" }),
    assign: async (id: number, who: string | null) => {
      calls.push(`assign ${id} ${who}`);
    },
    stateInfo: async () => ({ state: "New", states: agile }),
    setState: async (id: number, state: string) => {
      calls.push(`state ${id} ${state}`);
    },
    ...overrides,
  } as unknown as AzureBoardsClient;
  return { client, calls };
}

describe("applyBoardsStartWorkSideEffects", () => {
  it("assigns the viewer and moves the item to its in-progress state", async () => {
    const { client, calls } = stubClient();
    const warnings = await applyBoardsStartWorkSideEffects(client, 7, {
      assignSelf: true,
      moveToInProgress: true,
    });
    expect(warnings).toEqual([]);
    expect(calls).toEqual(["assign 7 jane@acme.com", "state 7 Active"]);
  });

  it("skips the state write when the item is already there", async () => {
    const { client, calls } = stubClient({
      stateInfo: async () => ({ state: "Active", states: agile }),
    });
    await applyBoardsStartWorkSideEffects(client, 7, { assignSelf: false, moveToInProgress: true });
    expect(calls).toEqual([]);
  });

  it("turns a failed assign into a warning instead of throwing", async () => {
    const { client } = stubClient({
      viewer: async () => {
        throw new Error("401");
      },
    });
    const warnings = await applyBoardsStartWorkSideEffects(client, 7, {
      assignSelf: true,
      moveToInProgress: false,
    });
    expect(warnings).toEqual(["could not assign work item: 401"]);
  });

  it("turns a failed state change into a warning", async () => {
    const { client } = stubClient({
      setState: async () => {
        throw new Error("400");
      },
    });
    const warnings = await applyBoardsStartWorkSideEffects(client, 7, {
      assignSelf: false,
      moveToInProgress: true,
    });
    expect(warnings).toEqual(["could not change state: 400"]);
  });

  it("warns when the type has no in-progress state", async () => {
    const { client } = stubClient({
      stateInfo: async () => ({ state: "New", states: [{ name: "New", category: "todo" }] }),
    });
    const warnings = await applyBoardsStartWorkSideEffects(client, 7, {
      assignSelf: false,
      moveToInProgress: true,
    });
    expect(warnings).toEqual(["no in-progress state available for this work item type"]);
  });

  it("names the requested state when the type doesn't allow it", async () => {
    const { client, calls } = stubClient();
    const warnings = await applyBoardsStartWorkSideEffects(client, 7, {
      assignSelf: false,
      moveToInProgress: true,
      state: "Doing",
    });
    expect(warnings).toEqual(['"Doing" is not a state this work item type allows']);
    expect(calls).toEqual([]);
  });
});
