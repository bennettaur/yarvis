import { describe, expect, it } from "bun:test";
import { TICKETS, VIEWER } from "./data";
import { handleJiraRequest, matchesJql } from "./server";

const request = (method: string, path: string, body?: unknown) =>
  handleJiraRequest({ method, url: new URL(`/rest/api/3${path}`, "http://fake"), body });

const search = (jql: string) =>
  (
    request("GET", `/search/jql?jql=${encodeURIComponent(jql)}`).json as {
      issues: { key: string; fields: { assignee: { accountId: string } | null } }[];
    }
  ).issues;

describe("fake JIRA", () => {
  it("lists the viewer's open tickets for the Assigned tab", () => {
    const hits = search(
      "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((i) => i.fields.assignee?.accountId === VIEWER.accountId)).toBe(true);
  });

  it("finds starred tickets by key, and anything else by text", () => {
    const [first] = TICKETS;
    expect(matchesJql(first, `issuekey in (${first.key}) ORDER BY updated DESC`)).toBe(true);
    expect(matchesJql(first, "issuekey in (PAY-1)")).toBe(false);
    expect(matchesJql(first, 'text ~ "brand logo"')).toBe(true);
    expect(matchesJql(first, 'text ~ "nothing like this"')).toBe(false);
  });

  it("keeps a status change and a comment, as the detail view reads them back", () => {
    const [ticket] = TICKETS;
    const { transitions } = request("GET", `/issue/${ticket.key}/transitions`).json as {
      transitions: { id: string; name: string }[];
    };
    const review = transitions.find((t) => t.name === "In Review");
    expect(review).toBeDefined();
    expect(
      request("POST", `/issue/${ticket.key}/transitions`, { transition: { id: review?.id } })
        .status,
    ).toBe(204);

    const adf = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "Ready for a look" }] }],
    };
    request("POST", `/issue/${ticket.key}/comment`, { body: adf });

    const issue = request("GET", `/issue/${ticket.key}`).json as {
      fields: { status: { name: string } };
    };
    expect(issue.fields.status.name).toBe("In Review");
    const { comments } = request("GET", `/issue/${ticket.key}/comment`).json as {
      comments: { body: unknown }[];
    };
    expect(comments[comments.length - 1]?.body).toEqual(adf);
  });

  it("drops a ticket moved to Done from the open lists", () => {
    const open = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
    const ticket = TICKETS.find((t) => t.key === "PAY-131");
    expect(search(open).some((i) => i.key === "PAY-131")).toBe(true);
    request("POST", `/issue/${ticket?.key}/transitions`, { transition: { id: "41" } });
    expect(search(open).some((i) => i.key === "PAY-131")).toBe(false);
  });

  it("creates a ticket with the next key in the project", () => {
    const created = request("POST", "/issue", {
      fields: { project: { key: "PAY" }, summary: "New thing", issuetype: { name: "Task" } },
    }).json as { key: string };
    const highest = Math.max(...TICKETS.map((t) => Number(t.key.split("-")[1])));
    expect(created.key).toBe(`PAY-${highest + 1}`);
    expect((request("GET", `/issue/${created.key}`).json as { key: string }).key).toBe(created.key);
  });
});
