import { describe, expect, it } from "bun:test";
import {
  applyStartWorkSideEffects,
  mergeIssues,
  mergeRepoIssues,
  type StartWorkSideEffectClient,
} from "./service.ts";
import type { IssueSummary } from "./types.ts";

function issue(externalId: string, createdAt: string): IssueSummary {
  return {
    provider: "github",
    sourceKey: "o/r",
    sourceLabel: "o/r",
    externalId,
    displayId: `#${externalId}`,
    title: `Issue ${externalId}`,
    url: `https://github.com/o/r/issues/${externalId}`,
    state: "open",
    author: "me",
    assignees: [],
    labels: [],
    createdAt,
    updatedAt: createdAt,
    commentCount: 0,
  };
}

describe("mergeIssues", () => {
  it("merges fulfilled results newest-first and drops rejected repos", () => {
    const results: PromiseSettledResult<IssueSummary[]>[] = [
      { status: "fulfilled", value: [issue("1", "2026-01-01"), issue("3", "2026-01-03")] },
      { status: "rejected", reason: new Error("repo B is a 404") },
      { status: "fulfilled", value: [issue("2", "2026-01-02")] },
    ];
    const merged = mergeIssues(results);
    expect(merged.map((i) => i.externalId)).toEqual(["3", "2", "1"]);
  });

  it("returns empty when every repo failed", () => {
    expect(mergeIssues([{ status: "rejected", reason: new Error("x") }])).toEqual([]);
  });
});

describe("mergeRepoIssues", () => {
  const repos = [
    { owner: "o", repo: "a" },
    { owner: "o", repo: "b" },
  ];

  it("keeps the repos that answered when only some failed", () => {
    const merged = mergeRepoIssues(repos, [
      { status: "fulfilled", value: [issue("1", "2026-01-01")] },
      { status: "rejected", reason: new Error("github /repos/o/b/issues -> 403") },
    ]);
    expect(merged.map((i) => i.externalId)).toEqual(["1"]);
  });

  it("throws the failure when every repo failed, rather than showing no issues", () => {
    const sso = new Error("github /repos/o/a/issues -> 403: requires SAML SSO");
    expect(() =>
      mergeRepoIssues(repos, [
        { status: "rejected", reason: sso },
        { status: "rejected", reason: new Error("x") },
      ]),
    ).toThrow(sso);
  });
});

/** A fake client that fails the operations named in `failOn`. */
function fakeClient(failOn: Set<string> = new Set()): {
  client: StartWorkSideEffectClient;
  calls: string[];
} {
  const calls: string[] = [];
  const guard = (name: string) => {
    calls.push(name);
    if (failOn.has(name)) throw new Error(`${name} failed`);
  };
  return {
    calls,
    client: {
      async viewer() {
        guard("viewer");
        return { login: "me" };
      },
      async assignIssue() {
        guard("assignIssue");
      },
      async ensureLabel() {
        guard("ensureLabel");
      },
      async addLabels() {
        guard("addLabels");
      },
    },
  };
}

const opts = { assignSelf: true, applyLabel: true, label: "in progress" };

describe("applyStartWorkSideEffects", () => {
  it("returns no warnings when assign and label both succeed", async () => {
    const { client, calls } = fakeClient();
    const warnings = await applyStartWorkSideEffects(client, "o", "r", 1, opts);
    expect(warnings).toEqual([]);
    expect(calls).toEqual(["viewer", "assignIssue", "ensureLabel", "addLabels"]);
  });

  it("degrades an assign failure to a warning and still labels", async () => {
    const { client, calls } = fakeClient(new Set(["assignIssue"]));
    const warnings = await applyStartWorkSideEffects(client, "o", "r", 1, opts);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not assign issue");
    expect(calls).toContain("ensureLabel"); // labeling still ran
  });

  it("degrades a label failure to a warning", async () => {
    const { client } = fakeClient(new Set(["ensureLabel"]));
    const warnings = await applyStartWorkSideEffects(client, "o", "r", 1, opts);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not label issue");
  });

  it("skips both when assignSelf and applyLabel are false", async () => {
    const { client, calls } = fakeClient();
    const warnings = await applyStartWorkSideEffects(client, "o", "r", 1, {
      assignSelf: false,
      applyLabel: false,
      label: "in progress",
    });
    expect(warnings).toEqual([]);
    expect(calls).toEqual([]);
  });
});
