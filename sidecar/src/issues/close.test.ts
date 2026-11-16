import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Config } from "../config.ts";
import { createIssueCloser } from "./close.ts";

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

const sent: Sent[] = [];
/** Replies keyed by a substring of the request URL; the first match wins. */
let replies: [string, unknown][] = [];

const fetchSpy = spyOn(globalThis, "fetch");
afterAll(() => fetchSpy.mockRestore());

beforeEach(() => {
  sent.length = 0;
  replies = [];
  fetchSpy.mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    sent.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const reply = replies.find(([match]) => url.includes(match));
    return new Response(reply ? JSON.stringify(reply[1]) : null, { status: reply ? 200 : 204 });
  }) as typeof fetch);
});
afterEach(() => fetchSpy.mockReset());

const config = (secrets: Partial<Config["secrets"]>) => ({ secrets }) as unknown as Config;

/** A reply to the status lookup for one JIRA issue. */
const jiraStatus = (key: string, category: string): [string, unknown] => [
  `/issue/${key}?fields`,
  { key, fields: { summary: key, status: { name: key, statusCategory: { key: category } } } },
];

const github = config({ githubToken: "gh-token" });
const jira = config({
  jiraBaseUrl: "https://acme.atlassian.net",
  jiraEmail: "me@example.com",
  jiraApiToken: "jira-token",
});
const azure = config({
  azureDevopsToken: "ado-token",
  azureDevopsOrgUrl: "https://dev.azure.com/acme",
});

describe("createIssueCloser", () => {
  it("closes a GitHub issue", async () => {
    await createIssueCloser(github)({
      provider: "github",
      sourceKey: "acme/widget",
      externalId: "12",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("PATCH");
    expect(sent[0]?.url).toEndWith("/repos/acme/widget/issues/12");
    expect(sent[0]?.body).toEqual({ state: "closed" });
  });

  it("refuses a GitHub link that doesn't name one issue in one repo", async () => {
    const close = createIssueCloser(github);
    for (const [sourceKey, externalId] of [
      ["acme/widget/extra", "12"],
      ["acme", "12"],
      ["acme/widget", "0"],
      ["acme/widget", "12/../13"],
      ["../widget", "12"],
      ["acme/widget#", "12"],
    ] as const) {
      await expect(close({ provider: "github", sourceKey, externalId })).rejects.toThrow(
        "not a GitHub issue",
      );
    }
    expect(sent).toHaveLength(0);
  });

  it("moves a JIRA issue to its Done status", async () => {
    replies = [
      jiraStatus("PROJ-4", "indeterminate"),
      [
        "/transitions",
        {
          transitions: [
            { id: "21", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
            { id: "31", to: { name: "Done", statusCategory: { key: "done" } } },
          ],
        },
      ],
    ];
    await createIssueCloser(jira)({ provider: "jira", sourceKey: "PROJ", externalId: "PROJ-4" });
    const post = sent.find((r) => r.method === "POST");
    expect(post?.url).toBe("https://acme.atlassian.net/rest/api/3/issue/PROJ-4/transitions");
    expect(post?.body).toEqual({ transition: { id: "31" } });
  });

  it("leaves a JIRA issue that is already done alone", async () => {
    replies = [jiraStatus("PROJ-5", "done")];
    await createIssueCloser(jira)({ provider: "jira", sourceKey: "PROJ", externalId: "PROJ-5" });
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
  });

  it("refuses a JIRA key that isn't one", async () => {
    await expect(
      createIssueCloser(jira)({ provider: "jira", sourceKey: "PROJ", externalId: ".." }),
    ).rejects.toThrow("not a JIRA issue key");
    expect(sent).toHaveLength(0);
  });

  it("fails a JIRA issue with no transition to a done status", async () => {
    replies = [jiraStatus("PROJ-4", "indeterminate"), ["/transitions", { transitions: [] }]];
    await expect(
      createIssueCloser(jira)({ provider: "jira", sourceKey: "PROJ", externalId: "PROJ-4" }),
    ).rejects.toThrow("no transition to a done status");
  });

  it("never sends tracker credentials to a host outside the allowlist", async () => {
    const jiraElsewhere = config({
      jiraBaseUrl: "https://jira.example.com",
      jiraEmail: "me@example.com",
      jiraApiToken: "jira-token",
    });
    const azureElsewhere = config({
      azureDevopsToken: "ado-token",
      azureDevopsOrgUrl: "https://azure.example.com/acme",
    });
    await expect(
      createIssueCloser(jiraElsewhere)({ provider: "jira", sourceKey: "P", externalId: "P-1" }),
    ).rejects.toThrow("not allowed");
    await expect(
      createIssueCloser(azureElsewhere)({ provider: "azure", sourceKey: "P", externalId: "1" }),
    ).rejects.toThrow("not allowed");
    expect(sent).toHaveLength(0);
  });

  it("closes GitHub issue #1", async () => {
    await createIssueCloser(github)({
      provider: "github",
      sourceKey: "acme/widget",
      externalId: "1",
    });
    expect(sent.map((r) => r.url)).toEqual([
      expect.stringContaining("/repos/acme/widget/issues/1"),
    ]);
  });

  it("treats a partly configured tracker as not configured and sends nothing", async () => {
    const partial = [
      config({ jiraBaseUrl: "https://acme.atlassian.net", jiraEmail: "me@example.com" }),
      config({ jiraBaseUrl: "https://acme.atlassian.net", jiraApiToken: "t" }),
      config({ jiraEmail: "me@example.com", jiraApiToken: "t" }),
    ];
    for (const c of partial) {
      await expect(
        createIssueCloser(c)({ provider: "jira", sourceKey: "P", externalId: "P-1" }),
      ).rejects.toThrow("JIRA is not configured");
    }
    for (const c of [
      config({ azureDevopsToken: "t" }),
      config({ azureDevopsOrgUrl: "https://dev.azure.com/acme" }),
    ]) {
      await expect(
        createIssueCloser(c)({ provider: "azure", sourceKey: "P", externalId: "1" }),
      ).rejects.toThrow("Azure Boards is not configured");
    }
    expect(sent).toEqual([]);
  });

  it("refuses an Azure id that isn't a work item number", async () => {
    await expect(
      createIssueCloser(azure)({ provider: "azure", sourceKey: "P", externalId: "7/../8" }),
    ).rejects.toThrow("not a work item id: 7/../8");
    expect(sent).toEqual([]);
  });

  it("fails an Azure work item whose type has no done state but Removed", async () => {
    replies = [
      [
        "/_apis/wit/workitems/9?",
        {
          fields: {
            "System.State": "Active",
            "System.TeamProject": "close-test-c",
            "System.WorkItemType": "Bug",
          },
        },
      ],
      [
        "/states",
        {
          value: [
            { name: "Active", category: "InProgress" },
            { name: "Removed", category: "Removed" },
          ],
        },
      ],
    ];
    await expect(
      createIssueCloser(azure)({ provider: "azure", sourceKey: "close-test-c", externalId: "9" }),
    ).rejects.toThrow("no done state available for this work item type");
    expect(sent.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("names the tracker that isn't configured", async () => {
    const none = createIssueCloser(config({}));
    await expect(none({ provider: "github", sourceKey: "a/b", externalId: "1" })).rejects.toThrow(
      "GitHub is not configured",
    );
    await expect(none({ provider: "jira", sourceKey: "P", externalId: "P-1" })).rejects.toThrow(
      "JIRA is not configured",
    );
    await expect(none({ provider: "azure", sourceKey: "P", externalId: "1" })).rejects.toThrow(
      "Azure Boards is not configured",
    );
  });

  it("moves an Azure work item to a done state other than Removed", async () => {
    replies = [
      [
        "/_apis/wit/workitems/7?",
        {
          fields: {
            "System.State": "Active",
            "System.TeamProject": "close-test-a",
            "System.WorkItemType": "Bug",
          },
        },
      ],
      [
        "/states",
        {
          value: [
            { name: "Active", category: "InProgress" },
            { name: "Removed", category: "Removed" },
            { name: "Closed", category: "Completed" },
          ],
        },
      ],
    ];
    await createIssueCloser(azure)({
      provider: "azure",
      sourceKey: "close-test-a",
      externalId: "7",
    });
    const patch = sent.find((r) => r.method === "PATCH");
    expect(patch?.body).toEqual([{ op: "add", path: "/fields/System.State", value: "Closed" }]);
  });

  it("leaves an Azure work item that is already done alone", async () => {
    replies = [
      [
        "/_apis/wit/workitems/8?",
        {
          fields: {
            "System.State": "Resolved",
            "System.TeamProject": "close-test-b",
            "System.WorkItemType": "Bug",
          },
        },
      ],
      [
        "/states",
        {
          value: [
            { name: "Resolved", category: "Resolved" },
            { name: "Closed", category: "Completed" },
          ],
        },
      ],
    ];
    await createIssueCloser(azure)({
      provider: "azure",
      sourceKey: "close-test-b",
      externalId: "8",
    });
    expect(sent.some((r) => r.method === "PATCH")).toBe(false);
  });
});
