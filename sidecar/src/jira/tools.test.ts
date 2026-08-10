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
    expect(result.description).toBe("Body text");
    expect(result.reporter).toBe("Rep Order");
    expect(result.assignee).toBe("As Signee");
    expect(result.labels).toEqual(["urgent"]);
    expect(result.comments[0]!.body).toBe("hi there");
    expect(result.linkedIssues[0]!.summary).toBe("Blocker sum");
  });
});
