import { describe, expect, it } from "bun:test";
import {
  AGENT_APPROVAL_PREFIX,
  AGENT_REVIEW_MARKER,
  type AgentReviewData,
  reportDigest,
} from "./agentReview.ts";
import {
  type AutoMergeContext,
  approveRefusal,
  autoMergeBlockers,
  type Comment,
  commentKind,
  decideAgentReview,
  decideReport,
  type GitHubUser,
  gateTier,
  mergePath,
  type PullRequest,
  parseApprove,
  parseTrusted,
} from "./gate.ts";
import { REPORT_MARKER, type ReportData } from "./report.ts";

const BENNETTAUR = { login: "bennettaur", id: 2670128 };
const SOMEONE = { login: "someone", id: 99 };
const HEAD = "abc1234def5678abc1234def5678abc1234def56";
const REPO = "bennettaur/yarvis";
const SIGNED_AT = "2026-10-24T12:00:00.000Z";
const NOW = new Date("2026-10-24T12:30:00.000Z");
const cleanReport: ReportData = {
  version: 2,
  repo: REPO,
  pr: 7,
  headSha: HEAD,
  issuedAt: SIGNED_AT,
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

/** Stands in for an SSH signature: real ones are covered in signing.test.ts. */
const fakeSign = (payload: string) => Buffer.from(`signed:${payload}`).toString("base64");
const fakeIsSigned = (payload: string, signature: string) => signature === fakeSign(payload);

let nextId = 1;
function reportComment(
  user: GitHubUser,
  report: ReportData = cleanReport,
  sign: (payload: string) => string = fakeSign,
): Comment {
  const data = Buffer.from(JSON.stringify(report)).toString("base64");
  return {
    id: nextId++,
    body: `${REPORT_MARKER}\n## Report\n<!-- yarvis-verify-data ${data} -->\n<!-- yarvis-verify-sig ${sign(data)} -->`,
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
    repo: REPO,
    pr: makePr(),
    files: lowRiskFiles,
    trusted: [BENNETTAUR.id],
    mode: "enforce",
    isReportSigned: fakeIsSigned,
    now: NOW,
    ...overrides,
  });
}

/** The decision, or a failure that names why the gate skipped instead. */
function acted(decision: ReturnType<typeof decideReport>) {
  if ("skip" in decision) throw new Error(`skipped: ${decision.skip}`);
  return decision;
}

describe("decideReport", () => {
  it("approves a current, clean, low-risk, signed report in enforce mode", () => {
    expect(decide()).toEqual({
      status: "Report: auto. Approved and set to auto-merge",
      approve: true,
    });
  });

  it("only sets the status in shadow mode", () => {
    expect(acted(decide({ mode: "shadow" })).approve).toBe(false);
  });

  it("ignores a report from someone who took a trusted user's old login", () => {
    expect(decide({ comment: reportComment({ login: "bennettaur", id: 12345 }) })).toEqual({
      skip: "posted by someone who isn't trusted",
    });
  });

  it("ignores a report posted by someone who isn't trusted", () => {
    expect("skip" in decide({ comment: reportComment(SOMEONE) })).toBe(true);
  });

  it("isn't displaced by a later report from someone untrusted", () => {
    const trusted = reportComment(BENNETTAUR);
    const forged = reportComment(SOMEONE);
    expect(acted(decide({ comment: trusted, comments: [trusted, forged] })).approve).toBe(true);
  });

  it("leaves an older trusted report alone when a newer one exists", () => {
    const older = reportComment(BENNETTAUR);
    const newer = reportComment(BENNETTAUR);
    expect(decide({ comment: older, comments: [older, newer] })).toEqual({
      skip: "a newer report exists",
    });
  });

  it("ignores a trusted user's report that isn't signed by an allowed key", () => {
    const comment = reportComment(BENNETTAUR, cleanReport, () => "bm90IGEgc2lnbmF0dXJl");
    expect(decide({ comment, comments: [comment] })).toEqual({
      skip: "the signature isn't from a key in VERIFY_ALLOWED_SIGNERS",
    });
  });

  it("ignores a report with no signature block at all", () => {
    const comment = reportComment(BENNETTAUR);
    comment.body = comment.body.replace(/\n<!-- yarvis-verify-sig [^ ]+ -->$/, "");
    expect(decide({ comment, comments: [comment] })).toEqual({
      skip: "no readable, signed data block",
    });
  });

  it("ignores a signed report moved from another PR", () => {
    const comment = reportComment(BENNETTAUR, { ...cleanReport, pr: 8 });
    expect(decide({ comment, comments: [comment] })).toEqual({
      skip: "signed for bennettaur/yarvis#8, not this PR",
    });
  });

  it("refuses a signed report re-posted long after it was signed", () => {
    expect(decide({ now: new Date("2026-10-25T12:00:00.000Z") })).toEqual({
      skip: "the report can't be acted on: it was signed 24 hours ago",
    });
  });

  it("refuses a report dated in the future, past clock skew", () => {
    expect(decide({ now: new Date("2026-10-24T11:00:00.000Z") })).toEqual({
      skip: "the report can't be acted on: it was signed in the future",
    });
  });

  it("sets no status for a report on an older commit", () => {
    expect(decide({ pr: makePr({ head: { sha: "f".repeat(40) } }) })).toEqual({
      skip: "for abc1234, but the head is fffffff",
    });
  });

  it("ignores a report whose data block is malformed", () => {
    const comment = reportComment(BENNETTAUR, { ...cleanReport, flagged: "x" } as never);
    expect("skip" in decide({ comment, comments: [comment] })).toBe(true);
  });

  it("reads only the signed block at the end, not one smuggled into the text", () => {
    const strict = { ...cleanReport, verdict: "human" as const };
    const comment = reportComment(BENNETTAUR, strict);
    const forged = Buffer.from(JSON.stringify(cleanReport)).toString("base64");
    comment.body = comment.body.replace(
      "## Report",
      `## Report\n<!-- yarvis-verify-data ${forged} -->\n<!-- yarvis-verify-sig ${fakeSign(forged)} -->`,
    );
    const decision = acted(decide({ comment, comments: [comment] }));
    expect(decision.approve).toBe(false);
    expect(decision.status).toContain("verdict is human");
  });

  it("refuses when the gate's own tier is higher than low", () => {
    const files = [{ path: "sidecar/src/agentTools/store.ts", additions: 1, deletions: 0 }];
    expect(acted(decide({ files })).status).toContain("high-risk change");
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

describe("mergePath", () => {
  const approval = (body: string, byBot: boolean, byMaintainer = false) => ({
    state: "APPROVED",
    body,
    byBot,
    byMaintainer,
  });

  it("tells the bot's two kinds of approval apart", () => {
    expect(mergePath([approval("Auto-approved: the report passed.", true)])).toBe("auto");
    expect(mergePath([approval("Approved by @bennettaur with /approve at abc.", true)])).toBe(
      "/approve",
    );
  });

  it("only believes the bot's wording from the bot", () => {
    expect(mergePath([approval("Auto-approved: trust me.", false)])).toBe("none");
  });

  it("lets a maintainer's own approval win over the bot's", () => {
    const reviews = [approval("Auto-approved: passed.", true), approval("LGTM", false, true)];
    expect(mergePath(reviews)).toBe("human");
  });

  it("ignores reviews that didn't approve", () => {
    expect(mergePath([{ ...approval("Auto-approved: x", true), state: "COMMENTED" }])).toBe("none");
  });
});

describe("decideAgentReview", () => {
  const agentReport: ReportData = { ...cleanReport, verdict: "agent", majors: 1 };

  function agentReviewComment(
    report: Comment,
    overrides: Partial<AgentReviewData> = {},
    sign: (payload: string) => string = fakeSign,
  ): Comment {
    const reportPayload = report.body.match(/yarvis-verify-data ([A-Za-z0-9+/=]+)/)?.[1] ?? "";
    const data: AgentReviewData = {
      version: 1,
      repo: REPO,
      pr: 7,
      headSha: HEAD,
      issuedAt: SIGNED_AT,
      reportDigest: reportDigest(reportPayload),
      decision: "approve",
      reason: "The major finding is handled in the follow-up commit.",
      ...overrides,
    };
    const block = Buffer.from(JSON.stringify(data)).toString("base64");
    return {
      id: nextId++,
      body: `${AGENT_REVIEW_MARKER}\nApproved.\n<!-- yarvis-agent-review-data ${block} -->\n<!-- yarvis-agent-review-sig ${sign(block)} -->`,
      html_url: "https://example.test/r",
      user: BENNETTAUR,
    };
  }

  function decideReview(overrides: Partial<Parameters<typeof decideAgentReview>[0]> = {}) {
    const report = reportComment(BENNETTAUR, agentReport);
    const comment = overrides.comment ?? agentReviewComment(report);
    return decideAgentReview({
      comment,
      comments: overrides.comments ?? [report, comment],
      repo: REPO,
      pr: makePr(),
      files: [{ path: "sidecar/src/memory/recall.ts", additions: 10, deletions: 0 }],
      trusted: [BENNETTAUR.id],
      mode: "enforce",
      isReportSigned: fakeIsSigned,
      isReviewSigned: fakeIsSigned,
      now: NOW,
      ...overrides,
    });
  }

  it("approves a standard-risk PR whose report asked for an agent and got one", () => {
    expect(decideReview()).toEqual({
      status: "Report: agent, approved by review and set to auto-merge",
      approve: true,
    });
  });

  it("only sets the status in shadow mode", () => {
    expect(acted(decideReview({ mode: "shadow" })).approve).toBe(false);
  });

  it("never approves a high-risk change", () => {
    const files = [{ path: "src-tauri/src/keychain.rs", additions: 1, deletions: 0 }];
    expect(acted(decideReview({ files })).status).toContain("high-risk change");
  });

  it("needs a signature from a key allowed for agent reviews", () => {
    expect(decideReview({ isReviewSigned: () => false })).toEqual({
      skip: "the agent review isn't signed by a key allowed for agent reviews",
    });
  });

  it("only counts a review of the exact report that is current", () => {
    const report = reportComment(BENNETTAUR, agentReport);
    const review = agentReviewComment(report);
    const newer = reportComment(BENNETTAUR, { ...agentReport, majors: 2 });
    expect(decideReview({ comment: review, comments: [report, review, newer] })).toEqual({
      skip: "the agent review read a different report than the latest one",
    });
  });

  it("only acts when the report asked for an agent's review", () => {
    const report = reportComment(BENNETTAUR, { ...cleanReport, verdict: "human" });
    const review = agentReviewComment(report);
    expect(decideReview({ comment: review, comments: [report, review] })).toEqual({
      skip: "the report's verdict is human, not agent",
    });
  });

  it("does nothing when the review rejects the PR", () => {
    const report = reportComment(BENNETTAUR, agentReport);
    const review = agentReviewComment(report, { decision: "reject", reason: "Untested branch." });
    expect(decideReview({ comment: review, comments: [report, review] })).toEqual({
      skip: "the agent review rejected it: Untested branch.",
    });
  });

  it("refuses a review for an older commit or another PR", () => {
    const report = reportComment(BENNETTAUR, agentReport);
    const stale = agentReviewComment(report, { headSha: "f".repeat(40) });
    expect(decideReview({ comment: stale, comments: [report, stale] })).toEqual({
      skip: "the agent review is for an older commit",
    });
    const moved = agentReviewComment(report, { pr: 8 });
    expect(decideReview({ comment: moved, comments: [report, moved] })).toEqual({
      skip: "the agent review is for another PR",
    });
  });

  it("ignores a review posted by someone untrusted, or under a taken-over login", () => {
    const report = reportComment(BENNETTAUR, agentReport);
    for (const user of [SOMEONE, { login: "bennettaur", id: 12345 }]) {
      const review = { ...agentReviewComment(report), user };
      expect(decideReview({ comment: review, comments: [report, review] })).toEqual({
        skip: "posted by someone who isn't trusted",
      });
    }
  });

  it("lets a later review win, so an earlier approve's late run does nothing", () => {
    const report = reportComment(BENNETTAUR, agentReport);
    const approve = agentReviewComment(report);
    const reject = agentReviewComment(report, { decision: "reject", reason: "No." });
    expect(decideReview({ comment: approve, comments: [report, approve, reject] })).toEqual({
      skip: "a newer agent review exists",
    });
  });

  it("keeps a reject standing even if the approve is re-posted after it", () => {
    const report = reportComment(BENNETTAUR, agentReport);
    const reject = agentReviewComment(report, { decision: "reject", reason: "No." });
    const reposted = agentReviewComment(report);
    expect(decideReview({ comment: reposted, comments: [report, reject, reposted] })).toEqual({
      skip: "a review of this same report rejected it",
    });
  });

  it("refuses a review signed long ago", () => {
    expect(decideReview({ now: new Date("2026-10-25T12:00:00.000Z") })).toEqual({
      skip: "the agent review can't be acted on: it was signed 24 hours ago",
    });
  });

  it("refuses when the report it rests on isn't current and signed", () => {
    const report = reportComment(BENNETTAUR, agentReport);
    const review = agentReviewComment(report);
    expect(decideReview({ isReportSigned: () => false })).toEqual({
      skip: "the signature isn't from a key in VERIFY_ALLOWED_SIGNERS",
    });
    expect(decideReview({ comment: review, comments: [review] })).toEqual({
      skip: "no report from a trusted user",
    });
    const moved = reportComment(BENNETTAUR, { ...agentReport, pr: 8 });
    const reviewOfMoved = agentReviewComment(moved);
    expect(decideReview({ comment: reviewOfMoved, comments: [moved, reviewOfMoved] })).toEqual({
      skip: "signed for bennettaur/yarvis#8, not this PR",
    });
  });

  it("doesn't merge a draft", () => {
    expect(acted(decideReview({ pr: makePr({ draft: true }) })).status).toContain("PR is a draft");
  });

  it("refuses when the current report has blockers or the author isn't trusted", () => {
    const report = reportComment(BENNETTAUR, { ...agentReport, blockers: 1 });
    const review = agentReviewComment(report);
    expect(acted(decideReview({ comment: review, comments: [report, review] })).status).toContain(
      "report has blocker findings",
    );
    expect(acted(decideReview({ pr: makePr({ user: SOMEONE }) })).status).toContain(
      "PR author is not a maintainer",
    );
  });
});

describe("mergePath and agent approvals", () => {
  const bot = (body: string) => ({ state: "APPROVED", body, byBot: true, byMaintainer: false });

  it("reads the bot's agent approval as its own path", () => {
    expect(mergePath([bot(`${AGENT_APPROVAL_PREFIX} x`)])).toBe("agent");
  });

  it("puts /approve ahead of an agent approval, and an agent approval ahead of auto", () => {
    expect(
      mergePath([bot(`${AGENT_APPROVAL_PREFIX} x`), bot("Approved by @b with /approve at a.")]),
    ).toBe("/approve");
    expect(mergePath([bot("Auto-approved: x"), bot(`${AGENT_APPROVAL_PREFIX} x`)])).toBe("agent");
  });
});

describe("commentKind", () => {
  it("routes each kind of comment to its own handler", () => {
    expect(commentKind("/approve")).toBe("approve");
    expect(commentKind(`${AGENT_REVIEW_MARKER}\n${REPORT_MARKER}`)).toBe("agent-review");
    expect(commentKind(`${REPORT_MARKER}\nreport`)).toBe("report");
    expect(commentKind("LGTM")).toBeNull();
  });
});
