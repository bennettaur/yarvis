import { describe, expect, it } from "bun:test";
import { GitHubError } from "../github/errors.ts";
import {
  botKind,
  type CheckRunOutput,
  type EvidenceItem,
  EvidenceUnavailable,
  plainText,
  prEvidence,
  type ScanAlert,
} from "./evidence.ts";
import { githubPrSource, type PrCodeSource } from "./source.ts";
import type { CheckItem, PrDetail, ReviewComment, ReviewThread } from "./types.ts";

const HEAD = "a".repeat(40);

const check = (name: string, conclusion: string | null, status = "COMPLETED"): CheckItem => ({
  name,
  status,
  conclusion,
  url: `https://github.com/o/r/actions/runs/${name}`,
});

const comment = (author: string, body: string, isBot = true): ReviewComment => ({
  id: `${author}-${body.length}`,
  author,
  body,
  createdAt: "2026-11-16T00:00:00Z",
  ...(isBot ? { isBot: true } : {}),
});

const thread = (comments: ReviewComment[], over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "t",
  path: "src/a.ts",
  line: 4,
  side: "RIGHT",
  isResolved: false,
  isOutdated: false,
  canReply: true,
  canResolve: true,
  canUnresolve: false,
  comments,
  ...over,
});

function source(over: {
  checks?: CheckItem[];
  checksUnavailable?: boolean;
  threads?: ReviewThread[];
  conversation?: ReviewComment[];
  outputs?: () => Promise<CheckRunOutput[] | null>;
  annotations?: PrCodeSource["checkRunAnnotations"];
  alerts?: () => Promise<ScanAlert[] | null>;
}): PrCodeSource {
  return {
    ref: { provider: "github", owner: "o", repo: "r", number: 1 },
    detail: async () =>
      ({
        headSha: HEAD,
        checks: over.checks ?? [],
        checksUnavailable: over.checksUnavailable,
        reviewThreads: over.threads ?? [],
        conversation: over.conversation ?? [],
      }) as unknown as PrDetail,
    files: async () => [],
    fileDiff: async () => {
      throw new Error("unused");
    },
    readFile: async () => "",
    listDir: async () => [],
    searchCode: async () => [],
    searchScope: "",
    checkRunOutputs: over.outputs ?? (async () => []),
    checkRunAnnotations: over.annotations ?? (async () => []),
    codeScanningAlerts: over.alerts ?? (async () => []),
  };
}

const byId = (items: EvidenceItem[], id: string) => items.find((i) => i.id === id);

describe("CI checks as evidence", () => {
  it("lists a failing check with the lines its run pointed at, and a passing one's warnings", async () => {
    const { items } = await prEvidence(
      source({
        checks: [check("tests", "FAILURE"), check("lint", "SUCCESS"), check("build", "SUCCESS")],
        outputs: async () => [
          {
            id: 1,
            name: "tests",
            app: "github-actions",
            title: "2 tests failed",
            summary: null,
            annotationsCount: 1,
          },
          {
            id: 2,
            name: "lint",
            app: "github-actions",
            title: null,
            summary: null,
            annotationsCount: 1,
          },
          {
            id: 3,
            name: "build",
            app: "github-actions",
            title: null,
            summary: null,
            annotationsCount: 0,
          },
        ],
        annotations: async (id) =>
          id === 1
            ? [
                {
                  path: "src/a.test.ts",
                  line: 12,
                  level: "failure",
                  title: "orders > sorts",
                  message: "expected 2, got 3",
                },
              ]
            : [
                {
                  path: "src/b.ts",
                  line: 3,
                  level: "warning",
                  title: null,
                  message: "unused import",
                },
              ],
      }),
    );
    const ci = byId(items, "ci-checks");
    expect(ci?.summary).toBe("1 of 3 failing");
    expect(ci?.tone).toBe("bad");
    expect(ci?.entries.map((e) => [e.severity, e.title, e.path, e.line])).toEqual([
      ["high", "tests: failed", null, null],
      ["high", "orders > sorts", "src/a.test.ts", 12],
      ["medium", "lint warning", "src/b.ts", 3],
    ]);
    expect(ci?.entries[0]?.detail).toBe("2 tests failed");
  });

  it("reads no annotations for a check that posted none", async () => {
    const asked: number[] = [];
    await prEvidence(
      source({
        checks: [check("build", "SUCCESS")],
        outputs: async () => [
          { id: 3, name: "build", app: null, title: null, summary: null, annotationsCount: 0 },
        ],
        annotations: async (id) => {
          asked.push(id);
          return [];
        },
      }),
    );
    expect(asked).toEqual([]);
  });

  it("says when every check passed, and when some are still running", async () => {
    const passed = await prEvidence(
      source({ checks: [check("a", "SUCCESS"), check("b", "SKIPPED")] }),
    );
    expect(byId(passed.items, "ci-checks")).toMatchObject({
      summary: "All 2 passed",
      tone: "good",
      entries: [],
    });
    const running = await prEvidence(
      source({ checks: [check("a", "SUCCESS"), check("b", null, "IN_PROGRESS")] }),
    );
    expect(byId(running.items, "ci-checks")).toMatchObject({
      summary: "1 of 2 still running",
      tone: "muted",
    });
  });

  it("still lists the checks when their output can't be read, and says why", async () => {
    const { items } = await prEvidence(
      source({
        checks: [check("tests", "FAILURE")],
        checksUnavailable: true,
        outputs: async () => {
          throw new EvidenceUnavailable("The token can't read check runs.");
        },
      }),
    );
    const ci = byId(items, "ci-checks");
    expect(ci?.entries.map((e) => e.title)).toEqual(["tests: failed"]);
    expect(ci?.note).toBe(
      "Some checks are hidden from the configured token, so this list is incomplete. The token can't read check runs.",
    );
  });

  it("keeps a check's link only when it is https", async () => {
    const { items } = await prEvidence(
      source({
        checks: [
          { ...check("a", "FAILURE"), url: "javascript:alert(1)" },
          { ...check("b", "FAILURE"), url: "https://ci.example.com/b" },
        ],
      }),
    );
    expect(byId(items, "ci-checks")?.entries.map((e) => e.url)).toEqual([
      null,
      "https://ci.example.com/b",
    ]);
  });
});

describe("code scanning alerts as evidence", () => {
  const alert = (severity: string, over: Partial<ScanAlert> = {}): ScanAlert => ({
    number: 1,
    tool: "CodeQL",
    rule: "js/sql-injection",
    severity,
    description: "Database query built from user-controlled sources",
    path: "src/db.ts",
    line: 10,
    message: "This query depends on a user-provided value.",
    url: "https://github.com/o/r/security/code-scanning/1",
    ...over,
  });

  it("lists open alerts, worst first", async () => {
    const { items } = await prEvidence(
      source({ alerts: async () => [alert("note", { number: 2 }), alert("critical")] }),
    );
    const scanning = byId(items, "code-scanning");
    expect(scanning?.summary).toBe("2 open alerts");
    expect(scanning?.tone).toBe("bad");
    expect(scanning?.entries.map((e) => e.severity)).toEqual(["high", "low"]);
    expect(scanning?.entries[0]).toMatchObject({ source: "CodeQL", path: "src/db.ts", line: 10 });
  });

  it("tells a provider without alerts apart from a token that can't read them", async () => {
    const none = await prEvidence(source({ alerts: async () => null }));
    expect(byId(none.items, "code-scanning")).toMatchObject({
      summary: "Not available",
      note: "This provider has no code scanning alerts.",
    });
    const refused = await prEvidence(
      source({
        alerts: async () => {
          throw new EvidenceUnavailable("Code scanning isn't set up for this repository.");
        },
      }),
    );
    expect(byId(refused.items, "code-scanning")?.note).toBe(
      "Code scanning isn't set up for this repository.",
    );
    const broken = await prEvidence(
      source({
        alerts: async () => {
          throw new Error("socket hang up");
        },
      }),
    );
    expect(byId(broken.items, "code-scanning")?.note).toContain(
      "Couldn't read code scanning alerts",
    );
  });
});

describe("bot comments as evidence", () => {
  it("groups open bot comments by the kind of bot, and leaves out people and resolved threads", async () => {
    const { items } = await prEvidence(
      source({
        threads: [
          thread([comment("semgrep-app", "**Possible SQL injection** in `query`")]),
          thread([comment("coderabbitai", "Consider a guard clause")], { isResolved: true }),
          thread([comment("alice", "Why this?", false)]),
        ],
        conversation: [
          comment("codecov", "## Coverage: 81% (-2%) <!-- hidden -->"),
          comment("copilot-pull-request-reviewer", "Reviewed 3 files"),
        ],
      }),
    );
    expect(items.map((i) => i.id)).toEqual([
      "ci-checks",
      "code-scanning",
      "security-bots",
      "coverage-bots",
      "other-bots",
    ]);
    expect(byId(items, "security-bots")?.entries).toEqual([
      {
        source: "semgrep-app",
        title: "semgrep-app",
        detail: "Possible SQL injection in query",
        severity: "medium",
        path: "src/a.ts",
        line: 4,
        url: null,
      },
    ]);
    expect(byId(items, "coverage-bots")?.entries[0]?.detail).toBe("Coverage: 81% (-2%)");
    expect(byId(items, "other-bots")?.entries.map((e) => e.source)).toEqual([
      "copilot-pull-request-reviewer",
    ]);
  });

  it("knows the common security and coverage bots by name", () => {
    expect(botKind("github-advanced-security")).toBe("security-bots");
    expect(botKind("Snyk-bot")).toBe("security-bots");
    expect(botKind("coveralls")).toBe("coverage-bots");
    expect(botKind("renovate")).toBe("other-bots");
  });
});

describe("plain text from what a tool wrote", () => {
  it("drops markup, images and links' targets, and caps the length", () => {
    expect(
      plainText(
        "<details><summary>Report</summary>\n\n![badge](https://x/y.svg) See [the docs](https://d) for `fix`</details>",
      ),
    ).toBe("Report See the docs for fix");
    expect(plainText("x".repeat(500), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("reading evidence from GitHub", () => {
  const client = (fail: Record<string, number>) => ({
    prDetail: async () => ({}) as PrDetail,
    prFiles: async () => [],
    commitCheckRuns: async () => {
      if (fail.checks) throw new GitHubError(fail.checks, "forbidden", "no", "check-runs");
      return [];
    },
    checkRunAnnotations: async () => [],
    prCodeScanningAlerts: async () => {
      if (fail.alerts) throw new GitHubError(fail.alerts, "not_found", "no", "code-scanning");
      return [];
    },
  });
  const sourceFor = (fail: Record<string, number>) =>
    githubPrSource(client(fail) as never, { provider: "github", owner: "o", repo: "r", number: 1 });

  it("says the token can't read check runs on a 403", async () => {
    await expect(sourceFor({ checks: 403 }).checkRunOutputs(HEAD)).rejects.toBeInstanceOf(
      EvidenceUnavailable,
    );
  });

  it("says why alerts are missing on a 403 and on a 404, and passes other errors on", async () => {
    await expect(sourceFor({ alerts: 403 }).codeScanningAlerts()).rejects.toThrow(
      "security_events",
    );
    await expect(sourceFor({ alerts: 404 }).codeScanningAlerts()).rejects.toThrow("isn't set up");
    const other = sourceFor({ alerts: 500 }).codeScanningAlerts();
    await expect(other).rejects.toBeInstanceOf(GitHubError);
  });
});
