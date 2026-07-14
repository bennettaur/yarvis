import { describe, expect, it } from "bun:test";
import type { GithubStar, IssueLink, IssueStar, Task } from "../db/schema.ts";
import type { IssueSummary } from "../issues/types.ts";
import type { PrSummary } from "../pr/types.ts";
import type { WorkspaceSummary } from "../workspaces/service.ts";
import { buildWipItems, type WipInputs } from "./service.ts";

const emptyInputs: WipInputs = {
  starredPrs: [],
  myPrs: [],
  inProgressIssues: [],
  labeledIssues: [],
  starredIssues: [],
  todayTasks: [],
  activeWorkspaces: [],
};

function labeledIssue(externalId: string): IssueSummary {
  return {
    provider: "github",
    sourceKey: "me/app",
    sourceLabel: "me/app",
    externalId,
    displayId: `#${externalId}`,
    title: `Labeled ${externalId}`,
    url: `https://github.com/me/app/issues/${externalId}`,
    state: "open",
    author: "me",
    assignees: ["me"],
    labels: [{ name: "in-progress", color: null }],
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z",
    commentCount: 0,
  };
}

function pr(number: number, owner = "me", repo = "app"): PrSummary {
  return {
    number,
    title: `PR ${number}`,
    url: `https://x/${number}`,
    owner,
    repo,
    author: "me",
    draft: false,
    state: "open",
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z",
  };
}

function star(number: number, owner = "me", repo = "app"): GithubStar {
  return {
    id: `s${number}`,
    owner,
    repo,
    number,
    title: `Star ${number}`,
    url: null,
    createdAt: new Date(),
  };
}

function link(
  externalId: string,
  localStatus: IssueLink["localStatus"] = "in_progress",
): IssueLink {
  return {
    id: `l${externalId}`,
    provider: "github",
    sourceKey: "me/app",
    externalId,
    title: `Issue ${externalId}`,
    url: null,
    localStatus,
    workspaceId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function issueStar(externalId: string): IssueStar {
  return {
    id: `is${externalId}`,
    provider: "github",
    sourceKey: "me/app",
    externalId,
    title: `Issue ${externalId}`,
    url: null,
    createdAt: new Date(),
  };
}

function task(id: string, status: Task["status"] = "open"): Task {
  return {
    id,
    title: `Task ${id}`,
    scope: "daily",
    status,
    targetDate: "2026-07-12",
    notes: null,
    sourceSessionId: null,
    workspaceId: null,
    createdAt: new Date(),
    completedAt: null,
  };
}

function workspace(id: string): WorkspaceSummary {
  return {
    id,
    name: `WS ${id}`,
    slug: id,
    status: "active",
    rootPath: `/tmp/${id}`,
    summary: null,
    mergedPrUrl: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    repoNames: ["app"],
  } as WorkspaceSummary;
}

describe("buildWipItems", () => {
  it("orders sources by priority: starred PRs, my PRs, issues, tasks, workspaces", () => {
    const items = buildWipItems({
      ...emptyInputs,
      starredPrs: [star(1)],
      myPrs: [pr(2)],
      inProgressIssues: [link("10")],
      starredIssues: [issueStar("11")],
      todayTasks: [task("t1")],
      activeWorkspaces: [workspace("w1")],
    });
    expect(items.map((i) => i.source)).toEqual([
      "starred-pr",
      "pr",
      "issue",
      "issue",
      "task",
      "workspace",
    ]);
  });

  it("does not list a PR that is both mine and starred twice", () => {
    const items = buildWipItems({ ...emptyInputs, starredPrs: [star(5)], myPrs: [pr(5)] });
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe("starred-pr");
  });

  it("does not list an issue that is both in-progress and starred twice", () => {
    const items = buildWipItems({
      ...emptyInputs,
      inProgressIssues: [link("7")],
      starredIssues: [issueStar("7")],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.navTarget).toEqual({
      type: "issue",
      provider: "github",
      sourceKey: "me/app",
      externalId: "7",
    });
  });

  it("excludes tasks that are already done", () => {
    const items = buildWipItems({ ...emptyInputs, todayTasks: [task("t1", "done")] });
    expect(items).toHaveLength(0);
  });

  it("lists labeled issues after in-progress ones", () => {
    const items = buildWipItems({
      ...emptyInputs,
      inProgressIssues: [link("1")],
      labeledIssues: [labeledIssue("2")],
    });
    expect(items.map((i) => i.id)).toEqual([
      "issue:github:me/app:1",
      "labeled-issue:github:me/app:2",
    ]);
  });

  it("does not list an issue that is both in-progress and labeled twice", () => {
    const items = buildWipItems({
      ...emptyInputs,
      inProgressIssues: [link("3")],
      labeledIssues: [labeledIssue("3")],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("issue:github:me/app:3");
  });
});
