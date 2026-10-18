import { describe, expect, it } from "bun:test";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { IssueSummary } from "../issues/types.ts";
import type { JiraClient } from "./client.ts";
import { buildJiraTools } from "./tools.ts";

// The AI SDK passes a second options argument to execute; tests don't need it.
const opts = { toolCallId: "test", messages: [] } as never;
const db = {} as Db; // unused by the read-only tools under test
const config = { secrets: {} } as Config;

// A zero-width space + HTML comment: exactly the hidden content sanitizeIssueText
// strips. If a tool forwards a field raw, the marker survives and the test fails.
const Z = "​";
const hostile = (visible: string) => `${visible.slice(0, 2)}${Z}${visible.slice(2)}<!--x-->`;

function summary(overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    provider: "jira",
    sourceKey: "PROJ",
    sourceLabel: "My Project",
    externalId: "PROJ-1",
    displayId: "PROJ-1",
    title: hostile("Fix login"),
    url: "https://acme.atlassian.net/browse/PROJ-1",
    state: "open",
    author: hostile("Jane Doe"),
    assignees: [hostile("Bob Smith")],
    labels: [{ name: hostile("urgent"), color: null }],
    createdAt: "",
    updatedAt: "",
    commentCount: 0,
    statusName: "To Do",
    statusCategory: "todo",
    issueType: "Bug",
    ...overrides,
  };
}

describe("jira tools: configuration gate", () => {
  it("returns an error (not a throw) when JIRA is not configured", async () => {
    const tools = buildJiraTools(db, config, { jiraClient: null });
    for (const t of [tools.jira_search_issues, tools.jira_get_issue, tools.jira_create_issue]) {
      const result = (await t.execute!(
        {
          jql: "x",
          key: "PROJ-1",
          projectKey: "PROJ",
          summary: "s",
          issueTypeName: "Task",
        } as never,
        opts,
      )) as {
        error?: string;
      };
      expect(result.error).toMatch(/not configured/i);
    }
  });
});

describe("jira tools: prompt-injection sanitization", () => {
  it("strips hidden characters from every free-text field of jira_search_issues", async () => {
    const jira = { searchIssues: async () => [summary()] } as unknown as JiraClient;
    const tools = buildJiraTools(db, config, { jiraClient: jira });
    const rows = (await tools.jira_search_issues.execute!({ jql: "x" } as never, opts)) as Array<{
      summary: string;
      reporter: string;
      assignee: string | null;
      labels: string[];
    }>;
    expect(rows[0]).toMatchObject({
      summary: "Fix login",
      reporter: "Jane Doe",
      assignee: "Bob Smith",
      labels: ["urgent"],
    });
  });

  it("strips hidden characters from body, comments, reporter, labels, and linked issues of jira_get_issue", async () => {
    const detail = {
      ...summary(),
      body: hostile("Body text"),
      reporter: hostile("Rep Order"),
      assignee: hostile("As Signee"),
      priority: "High",
      comments: [{ author: "C", body: hostile("hi there"), createdAt: "" }],
      linkedIssues: [
        {
          key: "PROJ-9",
          summary: hostile("Blocker sum"),
          statusName: "To Do",
          statusCategory: "todo",
          linkType: "blocks",
          issueType: "Task",
          url: "",
        },
      ],
    };
    const jira = { issueDetail: async () => detail } as unknown as JiraClient;
    const tools = buildJiraTools(db, config, { jiraClient: jira });
    const result = (await tools.jira_get_issue.execute!({ key: "PROJ-1" } as never, opts)) as {
      description: string;
      reporter: string;
      assignee: string | null;
      labels: string[];
      comments: Array<{ body: string }>;
      linkedIssues: Array<{ summary: string }>;
    };
    // Sanitized, then fenced as untrusted text.
    expect(result.description).toMatch(/^<ticket-text-\w+>\nBody text\n<\/ticket-text-\w+>$/);
    expect(result.reporter).toBe("Rep Order");
    expect(result.assignee).toBe("As Signee");
    expect(result.labels).toEqual(["urgent"]);
    expect(result.comments[0]!.body).toMatch(/^<ticket-text-\w+>\nhi there\n<\/ticket-text-\w+>$/);
    expect(result.linkedIssues[0]!.summary).toBe("Blocker sum");
  });
});

describe("jira tools: ticket changes", () => {
  const transitions = [
    {
      id: "11",
      name: "Start progress",
      toStatusName: "In Progress",
      toStatusCategory: "in_progress",
    },
    { id: "31", name: "Finish", toStatusName: "Done", toStatusCategory: "done" },
  ];

  /** A JIRA client that records the writes the tools make. Events go to a db
   *  stub; their recording failing is logged and swallowed by design. */
  function fakeJira(
    users: { accountId: string; displayName: string; email: string | null }[] = [],
  ) {
    const calls: { method: string; args: unknown[] }[] = [];
    const record =
      (method: string) =>
      async (...args: unknown[]) => {
        calls.push({ method, args });
      };
    const client = {
      transitions: async () => transitions,
      transitionIssue: record("transitionIssue"),
      assign: record("assign"),
      updateFields: record("updateFields"),
      addComment: record("addComment"),
      myself: async () => ({ login: "Me", accountId: "acc-me" }),
      searchAssignableUsers: async () => users,
      issueSummaryByKey: async () => summary(),
    } as unknown as JiraClient;
    return { client, calls };
  }

  it("transitions by target status or by transition name", async () => {
    const { client, calls } = fakeJira();
    const tools = buildJiraTools(db, config, { jiraClient: client });

    await tools.jira_transition_issue.execute!({ key: "PROJ-1", status: "done" }, opts);
    await tools.jira_transition_issue.execute!({ key: "PROJ-1", status: "Start progress" }, opts);

    expect(calls).toEqual([
      { method: "transitionIssue", args: ["PROJ-1", "31"] },
      { method: "transitionIssue", args: ["PROJ-1", "11"] },
    ]);
  });

  it("lists the available transitions when none leads to the asked-for status", async () => {
    const { client, calls } = fakeJira();
    const tools = buildJiraTools(db, config, { jiraClient: client });

    const result = (await tools.jira_transition_issue.execute!(
      { key: "PROJ-1", status: "In Review" },
      opts,
    )) as { error: string; available: { toStatus: string }[] };

    expect(result.error).toMatch(/In Review/);
    expect(result.available.map((t) => t.toStatus)).toEqual(["In Progress", "Done"]);
    expect(calls).toEqual([]);
  });

  it("assigns to the user, to nobody, or to the one matching user", async () => {
    const { client, calls } = fakeJira([{ accountId: "acc-ann", displayName: "Ann", email: null }]);
    const tools = buildJiraTools(db, config, { jiraClient: client });

    await tools.jira_assign_issue.execute!({ key: "PROJ-1", assignee: "me" }, opts);
    await tools.jira_assign_issue.execute!({ key: "PROJ-1", assignee: "nobody" }, opts);
    await tools.jira_assign_issue.execute!({ key: "PROJ-1", assignee: "Ann" }, opts);

    expect(calls).toEqual([
      { method: "assign", args: ["PROJ-1", "acc-me"] },
      { method: "assign", args: ["PROJ-1", null] },
      { method: "assign", args: ["PROJ-1", "acc-ann"] },
    ]);
  });

  it("returns the matches rather than guessing when a name matches several people", async () => {
    const { client, calls } = fakeJira([
      { accountId: "a1", displayName: "Ann Lee", email: null },
      { accountId: "a2", displayName: "Ann Park", email: null },
    ]);
    const tools = buildJiraTools(db, config, { jiraClient: client });

    const result = (await tools.jira_assign_issue.execute!(
      { key: "PROJ-1", assignee: "Ann" },
      opts,
    )) as { error: string; matches: string[] };

    expect(result.error).toMatch(/more than one/);
    expect(result.matches).toEqual(["Ann Lee", "Ann Park"]);
    expect(calls).toEqual([]);
  });

  it("picks the exact name when the search also finds longer ones", async () => {
    const { client, calls } = fakeJira([
      { accountId: "a1", displayName: "Alex Kim", email: null },
      { accountId: "a2", displayName: "Alex Kimball", email: null },
    ]);
    const tools = buildJiraTools(db, config, { jiraClient: client });

    await tools.jira_assign_issue.execute!({ key: "PROJ-1", assignee: "alex kim" }, opts);

    expect(calls).toEqual([{ method: "assign", args: ["PROJ-1", "a1"] }]);
  });

  it("says so when no assignable user matches", async () => {
    const { client, calls } = fakeJira([]);
    const tools = buildJiraTools(db, config, { jiraClient: client });

    const result = (await tools.jira_assign_issue.execute!(
      { key: "PROJ-1", assignee: "Zed" },
      opts,
    )) as { error: string; matches: string[] };

    expect(result).toEqual({ error: 'no assignable user matches "Zed"', matches: [] });
    expect(calls).toEqual([]);
  });

  it("returns JIRA's error to the model instead of throwing", async () => {
    const { client } = fakeJira();
    (client as unknown as { transitionIssue: () => Promise<void> }).transitionIssue = async () => {
      throw new Error("jira POST /issue/PROJ-1/transitions -> 400");
    };
    const tools = buildJiraTools(db, config, { jiraClient: client });

    const result = await tools.jira_transition_issue.execute!(
      { key: "PROJ-1", status: "Done" },
      opts,
    );

    expect(result).toEqual({ error: "jira POST /issue/PROJ-1/transitions -> 400" });
  });

  it("edits only the given fields, and comments", async () => {
    const { client, calls } = fakeJira();
    const tools = buildJiraTools(db, config, { jiraClient: client });

    await tools.jira_update_issue.execute!({ key: "PROJ-1", labels: ["a", "b"] }, opts);
    const commented = await tools.jira_comment_on_issue.execute!(
      { key: "PROJ-1", body: "PR is up" },
      opts,
    );

    expect(commented).toEqual({ commented: true, key: "PROJ-1" });
    expect(calls).toEqual([
      { method: "updateFields", args: ["PROJ-1", { labels: ["a", "b"] }] },
      { method: "addComment", args: ["PROJ-1", "PR is up"] },
    ]);
  });
});
