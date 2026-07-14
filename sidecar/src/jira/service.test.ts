import { describe, expect, it } from "bun:test";
import type { JiraClient } from "./client.ts";
import { applyJiraStartWorkSideEffects } from "./service.ts";
import type { JiraTransition } from "./types.ts";

interface Recorded {
  assigned?: string | null;
  transitionId?: string;
}

/**
 * A fake JiraClient exposing only the surface the side-effects use. `transitions`
 * is configurable, and any method can be made to throw to exercise the
 * degrade-to-warning paths.
 */
function fakeClient(opts: {
  transitions?: JiraTransition[];
  failAssign?: boolean;
  failTransitions?: boolean;
}): { client: JiraClient; recorded: Recorded } {
  const recorded: Recorded = {};
  const client = {
    myself: async () => ({ login: "Me", accountId: "acc-me" }),
    assign: async (_key: string, accountId: string | null) => {
      if (opts.failAssign) throw new Error("assign failed");
      recorded.assigned = accountId;
    },
    transitions: async () => {
      if (opts.failTransitions) throw new Error("transitions failed");
      return opts.transitions ?? [];
    },
    transitionIssue: async (_key: string, id: string) => {
      recorded.transitionId = id;
    },
  } as unknown as JiraClient;
  return { client, recorded };
}

const inProgress: JiraTransition = {
  id: "21",
  name: "Start Progress",
  toStatusName: "In Progress",
  toStatusCategory: "in_progress",
};
const done: JiraTransition = {
  id: "31",
  name: "Done",
  toStatusName: "Done",
  toStatusCategory: "done",
};

describe("applyJiraStartWorkSideEffects", () => {
  it("assigns self and transitions to the first in-progress status", async () => {
    const { client, recorded } = fakeClient({ transitions: [done, inProgress] });
    const warnings = await applyJiraStartWorkSideEffects(client, "PROJ-1", {
      assignSelf: true,
      transitionToInProgress: true,
    });
    expect(warnings).toEqual([]);
    expect(recorded.assigned).toBe("acc-me");
    expect(recorded.transitionId).toBe("21");
  });

  it("skips both side effects when the options are off", async () => {
    const { client, recorded } = fakeClient({ transitions: [inProgress] });
    const warnings = await applyJiraStartWorkSideEffects(client, "PROJ-1", {
      assignSelf: false,
      transitionToInProgress: false,
    });
    expect(warnings).toEqual([]);
    expect(recorded.assigned).toBeUndefined();
    expect(recorded.transitionId).toBeUndefined();
  });

  it("warns (without failing) when no in-progress transition is available", async () => {
    const { client, recorded } = fakeClient({ transitions: [done] });
    const warnings = await applyJiraStartWorkSideEffects(client, "PROJ-1", {
      assignSelf: false,
      transitionToInProgress: true,
    });
    expect(recorded.transitionId).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no in-progress transition");
  });

  it("degrades a failed assign to a warning and still attempts the transition", async () => {
    const { client, recorded } = fakeClient({ transitions: [inProgress], failAssign: true });
    const warnings = await applyJiraStartWorkSideEffects(client, "PROJ-1", {
      assignSelf: true,
      transitionToInProgress: true,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not assign issue");
    expect(recorded.transitionId).toBe("21");
  });

  it("degrades a failed transitions lookup to a warning", async () => {
    const { client } = fakeClient({ failTransitions: true });
    const warnings = await applyJiraStartWorkSideEffects(client, "PROJ-1", {
      assignSelf: false,
      transitionToInProgress: true,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not transition issue");
  });
});
