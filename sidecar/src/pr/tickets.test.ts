import { describe, expect, it } from "bun:test";
import type { IssueDetail } from "../issues/types.ts";
import { jiraKeysIn, loadTickets, parseTicket, type TicketReaders } from "./tickets.ts";
import type { PrRef, TicketRef } from "./types.ts";

const pr: PrRef = { provider: "github", owner: "o", repo: "r", number: 7 };

const detail = (title: string, over: Partial<IssueDetail> = {}): IssueDetail =>
  ({
    title,
    url: `https://tracker/${title}`,
    body: `Body of ${title}`,
    comments: [],
    ...over,
  }) as IssueDetail;

function readers(read: string[] = []): TicketReaders {
  return {
    github: async (owner, repo, number) => {
      read.push(`gh:${owner}/${repo}#${number}`);
      return detail(`issue ${number}`);
    },
    jira: {
      host: "acme.atlassian.net",
      read: async (key) => {
        read.push(`jira:${key}`);
        if (key === "UTF-8") throw new Error("Issue does not exist");
        return detail(key);
      },
    },
    azure: {
      org: "acme",
      read: async (id) => {
        read.push(`az:${id}`);
        return detail(`work item ${id}`);
      },
    },
  };
}

describe("naming a ticket", () => {
  it("accepts keys and links on the trackers Yarvis is set up for", () => {
    const cases: [string, TicketRef][] = [
      ["#12", { kind: "github", owner: "o", repo: "r", number: 12 }],
      ["https://github.com/a/b/issues/3", { kind: "github", owner: "a", repo: "b", number: 3 }],
      ["ABC-12", { kind: "jira", key: "ABC-12" }],
      ["https://acme.atlassian.net/browse/ABC-12", { kind: "jira", key: "ABC-12" }],
      ["AB#99", { kind: "azure", id: 99 }],
      ["https://dev.azure.com/acme/Proj/_workitems/edit/99", { kind: "azure", id: 99 }],
      ["https://acme.visualstudio.com/Proj/_workitems/edit/99/", { kind: "azure", id: 99 }],
    ];
    for (const [input, ref] of cases) expect(parseTicket(input, pr, readers())).toEqual(ref);
  });

  it("refuses a link to any other host, so nothing is fetched from it", () => {
    for (const input of [
      "https://evil.example/browse/ABC-12",
      "https://other.atlassian.net/browse/ABC-12",
      "https://dev.azure.com/other/Proj/_workitems/edit/99",
      "http://github.com/a/b/issues/3",
      "fix the bug",
    ]) {
      expect(parseTicket(input, pr, readers())).toHaveProperty("error");
    }
  });
});

describe("reading a PR's tickets", () => {
  it("reads named tickets, then linked ones, then Jira keys in the title and branch, each once", async () => {
    const read: string[] = [];
    const linked: TicketRef[] = [{ kind: "github", owner: "o", repo: "r", number: 12 }];
    const { tickets, notes } = await loadTickets(
      { ref: pr, linkedTickets: async () => linked },
      { title: "ABC-12: rename old", headRef: "feature/ABC-12-rename" },
      ["#12", "nonsense"],
      readers(read),
    );
    expect(read).toEqual(["gh:o/r#12", "jira:ABC-12"]);
    expect(tickets.map((t) => [t.key, t.title])).toEqual([
      ["#12", "issue 12"],
      ["ABC-12", "ABC-12"],
    ]);
    expect(notes).toEqual(["nonsense isn't a ticket Yarvis can read."]);
  });

  it("notes a ticket that can't be read and keeps the rest", async () => {
    const { tickets, notes } = await loadTickets(
      { ref: pr, linkedTickets: async () => [] },
      { title: "Handle UTF-8 names (ABC-3)", headRef: "main" },
      [],
      readers(),
    );
    expect(tickets.map((t) => t.key)).toEqual(["ABC-3"]);
    expect(notes).toEqual(["Couldn't read UTF-8: Issue does not exist"]);
  });

  it("reads Jira keys only when Jira is set up, and at most five tickets", async () => {
    const read: string[] = [];
    const noJira = { ...readers(read), jira: null };
    const { tickets, notes } = await loadTickets(
      {
        ref: pr,
        linkedTickets: async () =>
          [1, 2, 3, 4, 5, 6].map(
            (number): TicketRef => ({ kind: "github", owner: "o", repo: "r", number }),
          ),
      },
      { title: "ABC-12", headRef: "" },
      [],
      noJira,
    );
    expect(tickets).toHaveLength(5);
    expect(read.some((r) => r.startsWith("jira"))).toBe(false);
    expect(notes).toEqual(["1 more linked tickets weren't read."]);
  });

  it("still reads named tickets when the PR's links can't be read", async () => {
    const { tickets, notes } = await loadTickets(
      {
        ref: pr,
        linkedTickets: async () => {
          throw new Error("rate limited");
        },
      },
      { title: "", headRef: "" },
      ["AB#4"],
      readers(),
    );
    expect(tickets.map((t) => t.key)).toEqual(["AB#4"]);
    expect(notes[0]).toContain("Couldn't read the PR's linked tickets: rate limited");
  });

  it("finds keys standing on their own, not inside other words", () => {
    expect(jiraKeysIn("ABC-12 fix", "feature/XY-3-thing", "notABC-4", "ABC-55x")).toEqual([
      "ABC-12",
      "XY-3",
    ]);
  });
});
