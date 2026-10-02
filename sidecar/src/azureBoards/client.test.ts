import { describe, expect, it } from "bun:test";
import { AzureBoardsClient, mapStateCategory } from "./client.ts";

// Each test uses its own org so the module-level states cache can't leak a
// previous test's answer.
let orgCounter = 0;
const nextOrg = () => `https://dev.azure.com/acme${++orgCounter}`;

interface RecordedRequest {
  method: string;
  url: string;
  contentType: string | undefined;
  body: unknown;
}

/**
 * Fake fetch matching the request path (after the org URL, before the query
 * string) against a route table. A route key may be prefixed with a method, as
 * in "POST /_apis/wit/wiql". A value is the JSON body to return, or a
 * `{ status }` for an error response.
 */
function fakeFetch(
  org: string,
  routes: Record<string, unknown>,
  recorder?: RecordedRequest[],
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(url).replace(org, "").split("?")[0] ?? "";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    recorder?.push({
      method,
      url: String(url),
      contentType: headers["Content-Type"],
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const value = routes[`${method} ${path}`] ?? routes[path];
    if (value === undefined) return new Response("not found", { status: 404 });
    if (value && typeof value === "object" && "status" in (value as object)) {
      return new Response(JSON.stringify({ message: "nope" }), {
        status: (value as { status: number }).status,
      });
    }
    return new Response(JSON.stringify(value), { status: 200 });
  }) as unknown as typeof fetch;
}

function fields(overrides: Record<string, unknown> = {}) {
  return {
    "System.Title": "Fix the login bug",
    "System.State": "Active",
    "System.WorkItemType": "Bug",
    "System.AssignedTo": { displayName: "Jane Dev", uniqueName: "jane@acme.com" },
    "System.CreatedBy": { displayName: "Sam Report" },
    "System.CreatedDate": "2026-01-01T00:00:00Z",
    "System.ChangedDate": "2026-01-02T00:00:00Z",
    "System.Tags": "backend; urgent",
    "System.TeamProject": "Web App",
    "System.CommentCount": 2,
    ...overrides,
  };
}

const bugStates = {
  value: [
    { name: "New", category: "Proposed" },
    { name: "Active", category: "InProgress" },
    { name: "Resolved", category: "Resolved" },
    { name: "Closed", category: "Completed" },
  ],
};

describe("mapStateCategory", () => {
  it("folds Azure's categories onto to-do, in progress and done", () => {
    expect(mapStateCategory("Proposed")).toBe("todo");
    expect(mapStateCategory("InProgress")).toBe("in_progress");
    expect(mapStateCategory("Resolved")).toBe("done");
    expect(mapStateCategory("Completed")).toBe("done");
    expect(mapStateCategory("Removed")).toBe("done");
    expect(mapStateCategory(undefined)).toBe("todo");
  });
});

describe("AzureBoardsClient queries", () => {
  it("runs WIQL, then loads the hits in WIQL order with state categories", async () => {
    const org = nextOrg();
    const recorder: RecordedRequest[] = [];
    const client = new AzureBoardsClient(
      "pat",
      org,
      fakeFetch(
        org,
        {
          "POST /_apis/wit/wiql": { workItems: [{ id: 7 }, { id: 3 }] },
          "POST /_apis/wit/workitemsbatch": {
            value: [
              { id: 3, fields: fields({ "System.State": "New" }) },
              { id: 7, fields: fields() },
            ],
          },
          "/Web%20App/_apis/wit/workitemtypes/Bug/states": bugStates,
        },
        recorder,
      ),
    );

    const rows = await client.assignedToMe();

    expect(rows.map((r) => r.externalId)).toEqual(["7", "3"]);
    expect(rows[0]).toMatchObject({
      provider: "azure",
      sourceKey: "Web App",
      displayId: "#7",
      title: "Fix the login bug",
      url: `${org}/Web%20App/_workitems/edit/7`,
      state: "open",
      author: "Sam Report",
      assignees: ["Jane Dev"],
      labels: [
        { name: "backend", color: null },
        { name: "urgent", color: null },
      ],
      statusName: "Active",
      statusCategory: "in_progress",
      issueType: "Bug",
      commentCount: 2,
    });
    expect(rows[1]?.statusCategory).toBe("todo");
    const wiql = recorder.find((r) => r.url.includes("/wiql"));
    expect((wiql?.body as { query: string } | undefined)?.query).toContain(
      "[System.AssignedTo] = @Me",
    );
  });

  it("guesses the category from the state name when the type's states fail to load", async () => {
    const org = nextOrg();
    const client = new AzureBoardsClient(
      "pat",
      org,
      fakeFetch(org, {
        "POST /_apis/wit/workitemsbatch": {
          value: [{ id: 1, fields: fields({ "System.State": "Closed" }) }],
        },
        "/Web%20App/_apis/wit/workitemtypes/Bug/states": { status: 500 },
      }),
    );

    const [row] = await client.workItems([1]);

    expect(row?.statusCategory).toBe("done");
    expect(row?.state).toBe("closed");
  });

  it("escapes quotes in a title search", async () => {
    const org = nextOrg();
    const recorder: RecordedRequest[] = [];
    const client = new AzureBoardsClient(
      "pat",
      org,
      fakeFetch(org, { "POST /_apis/wit/wiql": { workItems: [] } }, recorder),
    );

    expect(await client.searchTitle("it's broken")).toEqual([]);
    const query = (recorder[0]?.body as { query: string } | undefined)?.query;
    expect(query).toContain("[System.Title] CONTAINS 'it''s broken'");
  });

  it("loads detail with the description as Markdown, comments and states", async () => {
    const org = nextOrg();
    const client = new AzureBoardsClient(
      "pat",
      org,
      fakeFetch(org, {
        "/_apis/wit/workitems/7": {
          id: 7,
          fields: fields({
            "System.Description": "<div>Steps: <b>login</b></div>",
            "Microsoft.VSTS.Common.Priority": 2,
          }),
        },
        "/Web%20App/_apis/wit/workItems/7/comments": {
          comments: [
            { text: "<p>Seen it too</p>", createdBy: { displayName: "Ann" }, createdDate: "d1" },
          ],
        },
        "/Web%20App/_apis/wit/workitemtypes/Bug/states": bugStates,
      }),
    );

    const detail = await client.workItemDetail(7);

    expect(detail.body).toBe("Steps: **login**");
    expect(detail.comments).toEqual([{ author: "Ann", body: "Seen it too", createdAt: "d1" }]);
    expect(detail.commentCount).toBe(1);
    expect(detail.priority).toBe("2");
    expect(detail.assignee).toBe("Jane Dev");
    expect(detail.states.map((s) => s.name)).toEqual(["New", "Active", "Resolved", "Closed"]);
  });

  it("falls back to Repro Steps when a bug has no description", async () => {
    const org = nextOrg();
    const client = new AzureBoardsClient(
      "pat",
      org,
      fakeFetch(org, {
        "/_apis/wit/workitems/7": {
          id: 7,
          fields: fields({ "Microsoft.VSTS.TCM.ReproSteps": "<div>Click login</div>" }),
        },
        "/Web%20App/_apis/wit/workItems/7/comments": { comments: [] },
        "/Web%20App/_apis/wit/workitemtypes/Bug/states": bugStates,
      }),
    );

    const detail = await client.workItemDetail(7);
    expect(detail.body).toBe("Click login");
    expect(detail.bodyField).toBe("reproSteps");
  });
});

describe("AzureBoardsClient.workItems", () => {
  it("skips items the batch omits because they were deleted", async () => {
    const org = nextOrg();
    const client = new AzureBoardsClient(
      "pat",
      org,
      fakeFetch(org, {
        "POST /_apis/wit/workitemsbatch": { value: [null, { id: 2, fields: fields() }] },
        "/Web%20App/_apis/wit/workitemtypes/Bug/states": bugStates,
      }),
    );

    const rows = await client.workItems([1, 2]);

    expect(rows.map((r) => r.externalId)).toEqual(["2"]);
  });
});

describe("AzureBoardsClient mutations", () => {
  it("writes Repro Steps, not Description, when that is the field being edited", async () => {
    const org = nextOrg();
    const recorder: RecordedRequest[] = [];
    const client = new AzureBoardsClient(
      "pat",
      org,
      fakeFetch(org, { "PATCH /_apis/wit/workitems/7": { id: 7 } }, recorder),
    );

    await client.updateFields(7, { reproSteps: "Click login" });

    expect(recorder[0]?.body).toEqual([
      {
        op: "add",
        path: "/fields/Microsoft.VSTS.TCM.ReproSteps",
        value: "<div>Click login</div>",
      },
    ]);
  });

  it("sends field edits as a JSON Patch document", async () => {
    const org = nextOrg();
    const recorder: RecordedRequest[] = [];
    const client = new AzureBoardsClient(
      "pat",
      org,
      fakeFetch(org, { "PATCH /_apis/wit/workitems/7": { id: 7 } }, recorder),
    );

    await client.updateFields(7, { title: "New title", description: "a < b", tags: ["x", "y"] });

    expect(recorder[0]?.contentType).toBe("application/json-patch+json");
    expect(recorder[0]?.body).toEqual([
      { op: "add", path: "/fields/System.Title", value: "New title" },
      { op: "add", path: "/fields/System.Description", value: "<div>a &lt; b</div>" },
      { op: "add", path: "/fields/System.Tags", value: "x; y" },
    ]);
  });

  it("clears the assignee with a remove op", async () => {
    const org = nextOrg();
    const recorder: RecordedRequest[] = [];
    const client = new AzureBoardsClient(
      "pat",
      org,
      fakeFetch(org, { "PATCH /_apis/wit/workitems/7": { id: 7 } }, recorder),
    );

    await client.assign(7, null);

    expect(recorder[0]?.body).toEqual([{ op: "remove", path: "/fields/System.AssignedTo" }]);
  });

  it("posts a comment to the item's project", async () => {
    const org = nextOrg();
    const recorder: RecordedRequest[] = [];
    const client = new AzureBoardsClient(
      "pat",
      org,
      fakeFetch(
        org,
        {
          "/_apis/wit/workitems/7": { id: 7, fields: { "System.TeamProject": "Web App" } },
          "POST /Web%20App/_apis/wit/workItems/7/comments": {
            text: "<div>hi</div>",
            createdBy: { displayName: "Me" },
            createdDate: "d2",
          },
        },
        recorder,
      ),
    );

    const comment = await client.addComment(7, "hi");

    expect(comment).toEqual({ author: "Me", body: "hi", createdAt: "d2" });
    const post = recorder.find((r) => r.method === "POST");
    expect(post?.url).toContain("api-version=7.1-preview.4");
    expect(post?.body).toEqual({ text: "<div>hi</div>" });
  });

  it("includes Azure's error message when a request fails", async () => {
    const org = nextOrg();
    const client = new AzureBoardsClient(
      "pat",
      org,
      fakeFetch(org, { "PATCH /_apis/wit/workitems/7": { status: 400 } }),
    );

    await expect(client.setState(7, "Nope")).rejects.toThrow(/-> 400: nope/);
  });
});

describe("AzureBoardsClient.viewer", () => {
  it("prefers the account email as the unique name", async () => {
    const org = nextOrg();
    const client = new AzureBoardsClient(
      "pat",
      org,
      fakeFetch(org, {
        "/_apis/connectionData": {
          authenticatedUser: {
            id: "u1",
            providerDisplayName: "Jane Dev",
            properties: { Account: { $value: "jane@acme.com" } },
          },
        },
      }),
    );

    expect(await client.viewer()).toEqual({ login: "Jane Dev", uniqueName: "jane@acme.com" });
  });

  it("asks Azure once per org and token", async () => {
    const org = nextOrg();
    const recorder: RecordedRequest[] = [];
    const routes = {
      "/_apis/connectionData": { authenticatedUser: { id: "u1", providerDisplayName: "Jane" } },
    };
    await new AzureBoardsClient("pat", org, fakeFetch(org, routes, recorder)).viewer();
    await new AzureBoardsClient("pat", org, fakeFetch(org, routes, recorder)).viewer();
    await new AzureBoardsClient("other", org, fakeFetch(org, routes, recorder)).viewer();

    expect(recorder).toHaveLength(2);
  });
});
