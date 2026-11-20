import { describe, expect, it } from "bun:test";
import type { IssueDetail } from "../issues/types.ts";
import {
  jiraKeysIn,
  loadTickets,
  parseTicket,
  type TicketReaders,
  ticketReaders,
} from "./tickets.ts";
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
      { title: "ABC-12: rename old", headRef: "feature/ABC-12-rename", fromFork: false },
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
      { title: "Handle UTF-8 names (ABC-3)", headRef: "main", fromFork: false },
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
      { title: "ABC-12", headRef: "", fromFork: false },
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
      { title: "", headRef: "", fromFork: false },
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

describe("what a PR's author can make Yarvis read", () => {
  it("reads no Jira key from the title or branch of a PR from a fork, and says so", async () => {
    const read: string[] = [];
    const { tickets, notes } = await loadTickets(
      { ref: pr, linkedTickets: async () => [] },
      { title: "SEC-42 tweak", headRef: "fix/HR-7", fromFork: true },
      [],
      readers(read),
    );
    expect(tickets).toEqual([]);
    expect(read).toEqual([]);
    expect(notes).toEqual([
      "Didn't look up SEC-42, HR-7 from the title or branch: the PR comes from a fork. Name them to read them.",
    ]);
  });

  it("still reads a key the reviewer names on a PR from a fork", async () => {
    const { tickets } = await loadTickets(
      { ref: pr, linkedTickets: async () => [] },
      { title: "SEC-42 tweak", headRef: "", fromFork: true },
      ["SEC-42"],
      readers(),
    );
    expect(tickets.map((t) => t.key)).toEqual(["SEC-42"]);
  });

  it("reads only the closed issues in the PR's own repository", async () => {
    const read: string[] = [];
    const { tickets, notes } = await loadTickets(
      {
        ref: pr,
        linkedTickets: async () => [
          { kind: "github", owner: "o", repo: "r", number: 1 },
          { kind: "github", owner: "other", repo: "private", number: 9 },
        ],
      },
      { title: "", headRef: "", fromFork: false },
      [],
      readers(read),
    );
    expect(read).toEqual(["gh:o/r#1"]);
    expect(tickets.map((t) => t.key)).toEqual(["#1"]);
    expect(notes).toEqual([
      "Didn't read other/private#9: it's in another repository. Name it to read it.",
    ]);
  });
});

describe("naming a ticket, refused", () => {
  it("refuses an owner or repo that isn't a plain name, and #12 on an Azure PR", () => {
    expect(parseTicket("https://github.com/a%2F../b/issues/3", pr, readers())).toHaveProperty(
      "error",
    );
    const azurePr: PrRef = { provider: "azure", org: "acme", project: "P", repo: "R", prId: 4 };
    expect(parseTicket("#12", azurePr, readers())).toHaveProperty("error");
  });

  it("notes a Jira key when Jira isn't set up", async () => {
    const { tickets, notes } = await loadTickets(
      { ref: pr, linkedTickets: async () => [] },
      { title: "", headRef: "", fromFork: false },
      ["ABC-1"],
      { ...readers(), jira: null },
    );
    expect(tickets).toEqual([]);
    expect(notes).toEqual(["Couldn't read ABC-1: Jira isn't set up"]);
  });
});

describe("the trackers Yarvis reads tickets from", () => {
  const config = (secrets: Record<string, string>) =>
    ({ secrets, endpoints: undefined }) as unknown as Parameters<typeof ticketReaders>[0];

  it("reads only from trackers whose settings are complete and on an allowed host", () => {
    expect(ticketReaders(config({}))).toEqual({ github: null, jira: null, azure: null });
    const jiraOff = ticketReaders(
      config({ jiraBaseUrl: "https://evil.example", jiraEmail: "e", jiraApiToken: "t" }),
    );
    expect(jiraOff.jira).toBeNull();
    const azureOff = ticketReaders(
      config({ azureDevopsToken: "t", azureDevopsOrgUrl: "https://evil.example/acme" }),
    );
    expect(azureOff.azure).toBeNull();
  });

  it("takes the Jira host and Azure org from the configured URLs", () => {
    const on = ticketReaders(
      config({
        githubToken: "g",
        jiraBaseUrl: "https://acme.atlassian.net",
        jiraEmail: "e",
        jiraApiToken: "t",
        azureDevopsToken: "t",
        azureDevopsOrgUrl: "https://legacy.visualstudio.com",
      }),
    );
    expect(on.github).not.toBeNull();
    expect(on.jira?.host).toBe("acme.atlassian.net");
    expect(on.azure?.org).toBe("legacy");
  });
});
