import { describe, expect, it } from "bun:test";
import {
  type AutoMergeContext,
  approveRefusal,
  autoMergeBlockers,
  type Comment,
  decideReport,
  type GitHubUser,
  gateTier,
  type PullRequest,
  parseApprove,
  parseTrusted,
} from "./gate.ts";
import { REPORT_MARKER, type ReportData } from "./report.ts";

const BENNETTAUR = { login: "bennettaur", id: 2670128 };
const SOMEONE = { login: "someone", id: 99 };
const HEAD = "abc1234def5678abc1234def5678abc1234def56";
const cleanReport: ReportData = {
  version: 1,
  headSha: HEAD,
  verdict: "auto",
  blockers: 0,
  majors: 0,
  flagged: [],
};

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    node_id: "PR_1",
    number: 7,
    state: "open",
    draft: false,
    changed_files: 1,
    user: BENNETTAUR,
    head: { sha: HEAD },
    ...overrides,
  };
}

let nextId = 1;
function reportComment(user: GitHubUser, report: ReportData = cleanReport): Comment {
  const data = Buffer.from(JSON.stringify(report)).toString("base64");
  return {
    id: nextId++,
    body: `${REPORT_MARKER}\n## Report\n<!-- yarvis-verify-data ${data} -->`,
    html_url: "https://example.test/c",
    user,
  };
}

const lowRiskFiles = [{ path: "src/components/List.tsx", additions: 10, deletions: 0 }];

function decide(overrides: Partial<Parameters<typeof decideReport>[0]> = {}) {
  const comment = overrides.comment ?? reportComment(BENNETTAUR);
  return decideReport({
    comment,
    comments: [comment],
    pr: makePr(),
    files: lowRiskFiles,
    trusted: [BENNETTAUR.id],
    mode: "enforce",
    ...overrides,
  });
}

describe("decideReport", () => {
  it("approves a current, clean, low-risk report in enforce mode", () => {
    expect(decide()).toEqual({
      status: "Report: auto. Approved and set to auto-merge",
      approve: true,
    });
  });

  it("only sets the status in shadow mode", () => {
    expect(decide({ mode: "shadow" })?.approve).toBe(false);
  });

  it("ignores a report from someone who took a trusted user's old login", () => {
    expect(decide({ comment: reportComment({ login: "bennettaur", id: 12345 }) })).toBeNull();
  });

  it("ignores a report posted by someone who isn't trusted", () => {
    expect(decide({ comment: reportComment(SOMEONE) })).toBeNull();
  });

  it("isn't displaced by a later report from someone untrusted", () => {
    const trusted = reportComment(BENNETTAUR);
    const forged = reportComment(SOMEONE);
    expect(decide({ comment: trusted, comments: [trusted, forged] })?.approve).toBe(true);
  });

  it("leaves an older trusted report alone when a newer one exists", () => {
    const older = reportComment(BENNETTAUR);
    const newer = reportComment(BENNETTAUR);
    expect(decide({ comment: older, comments: [older, newer] })).toBeNull();
  });

  it("sets no status for a report on an older commit", () => {
    expect(decide({ pr: makePr({ head: { sha: "f".repeat(40) } }) })).toBeNull();
  });

  it("ignores a report whose data block is malformed", () => {
    const comment = reportComment(BENNETTAUR, { ...cleanReport, flagged: "x" } as never);
    expect(decide({ comment, comments: [comment] })).toBeNull();
  });

  it("reads only the data block at the end, not one smuggled into the text", () => {
    const strict = { ...cleanReport, verdict: "human" as const };
    const comment = reportComment(BENNETTAUR, strict);
    const forged = Buffer.from(JSON.stringify(cleanReport)).toString("base64");
    comment.body = comment.body.replace(
      "## Report",
      `## Report\n<!-- yarvis-verify-data ${forged} -->`,
    );
    const decision = decide({ comment, comments: [comment] });
    expect(decision?.approve).toBe(false);
    expect(decision?.status).toContain("verdict is human");
  });

  it("refuses when the gate's own tier is higher than low", () => {
    const files = [{ path: "sidecar/src/agentTools/store.ts", additions: 1, deletions: 0 }];
    expect(decide({ files })?.status).toContain("high-risk change");
  });
});

describe("gateTier", () => {
  it("classifies the old path of a renamed file", () => {
    const moved = [
      {
        path: "src/lib/x.ts",
        previousPath: ".github/workflows/ci.yml",
        additions: 0,
        deletions: 0,
      },
    ];
    expect(gateTier(makePr(), moved)).toBe("high");
  });

  it("counts a file list cut short by the API as high risk", () => {
    expect(gateTier(makePr({ changed_files: 2 }), lowRiskFiles)).toBe("high");
  });
});

function makeContext(overrides: Partial<AutoMergeContext> = {}): AutoMergeContext {
  return {
    report: cleanReport,
    prAuthor: BENNETTAUR,
    draft: false,
    trusted: [BENNETTAUR.id],
    tier: "low",
    ...overrides,
  };
}

describe("autoMergeBlockers", () => {
  it("allows a clean, low-risk report on a maintainer's PR", () => {
    expect(autoMergeBlockers(makeContext())).toEqual([]);
  });

  it("refuses an outside contributor's PR even with a clean report", () => {
    expect(autoMergeBlockers(makeContext({ prAuthor: SOMEONE }))).toContain(
      "PR author is not a maintainer",
    );
  });

  it("goes by the author's ID, not their login", () => {
    expect(
      autoMergeBlockers(makeContext({ prAuthor: { login: "bennettaur", id: 12345 } })),
    ).toContain("PR author is not a maintainer");
  });

  it("refuses drafts", () => {
    expect(autoMergeBlockers(makeContext({ draft: true }))).toContain("PR is a draft");
  });

  it("refuses a verdict other than auto", () => {
    const report = { ...cleanReport, verdict: "agent" as const };
    expect(autoMergeBlockers(makeContext({ report }))).toContain("verdict is agent");
  });

  it("refuses findings counts that contradict an auto verdict", () => {
    const report = { ...cleanReport, blockers: 1 };
    expect(autoMergeBlockers(makeContext({ report }))).toContain(
      "report has blocker or major findings",
    );
  });

  it("refuses flagged checks", () => {
    const report = { ...cleanReport, flagged: ["coverage"] };
    expect(autoMergeBlockers(makeContext({ report }))).toContain("flagged: coverage");
  });
});

describe("parseApprove", () => {
  it("reads the bare command and the form naming a commit", () => {
    expect(parseApprove("/approve")).toEqual({});
    expect(parseApprove("  /approve ABC1234 \n")).toEqual({ sha: "abc1234" });
  });

  it("ignores anything else", () => {
    expect(parseApprove("/approve please, and also delete main")).toBeNull();
    expect(parseApprove("I'll /approve later")).toBeNull();
    expect(parseApprove("/approve abc")).toBeNull();
  });
});

describe("approveRefusal", () => {
  const trusted = [BENNETTAUR.id];

  it("trusts by ID, so someone who took a trusted user's old login isn't trusted", () => {
    const impostor = { login: "bennettaur", id: 12345 };
    expect(approveRefusal({ commenter: impostor, pr: makePr(), trusted })).toBe(
      "commenter is not trusted",
    );
  });

  it("lets a maintainer approve their own PR without naming a commit", () => {
    expect(approveRefusal({ commenter: BENNETTAUR, pr: makePr(), trusted })).toBeNull();
  });

  it("refuses someone who isn't trusted", () => {
    expect(approveRefusal({ commenter: SOMEONE, pr: makePr(), trusted })).toBe(
      "commenter is not trusted",
    );
  });

  it("requires an outside contributor's PR to name the reviewed commit", () => {
    const pr = makePr({ user: SOMEONE });
    expect(approveRefusal({ commenter: BENNETTAUR, pr, trusted })).toContain("/approve <sha>");
    expect(approveRefusal({ commenter: BENNETTAUR, sha: "abc1234", pr, trusted })).toBeNull();
  });

  it("refuses when the head moved past the named commit", () => {
    expect(
      approveRefusal({ commenter: BENNETTAUR, sha: "0000000", pr: makePr(), trusted }),
    ).toContain("the head is now abc1234");
  });
});

describe("parseTrusted", () => {
  it("reads numeric IDs and skips anything else, such as a login", () => {
    expect(parseTrusted(" 2670128, ,bennettaur, 42 ")).toEqual([2670128, 42]);
    expect(parseTrusted(undefined)).toEqual([]);
  });
});
