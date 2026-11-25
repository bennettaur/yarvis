import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { FeedbackInput, ReportFeedback } from "../../../lib/reviewWorkspaces/feedback";
import type { VerificationReport } from "../../../lib/reviewWorkspaces/verification";
import { mountForInteraction, textOf, waitFor } from "../../../test/render";
import type { AskTarget, ReportActions } from "./ReportItemActions";
import VerificationReportView from "./VerificationReportView";

const report: VerificationReport = {
  mustRead: [
    {
      path: "src/panel.tsx",
      reason: "Parse and confirm states",
      lines: { start: 57, end: 107 },
      flags: [{ note: "Old proposal isn't cleared on re-parse", line: 69 }],
    },
  ],
  risk: {
    level: "high",
    clientImpact: "The mic keeps sending.",
    mitigations: [],
    concerns: [
      {
        title: "Voice keeps sending",
        detail: "Hidden mic stays live.",
        path: "src/chat.tsx",
        line: 202,
      },
    ],
  },
  tests: {
    status: "issues",
    findings: [
      {
        title: "Toggle untested",
        detail: "Nothing clicks it.",
        severity: "medium",
        path: "src/chat.tsx",
        line: 104,
      },
    ],
  },
};

/** A feedback store in memory, keyed like the sidecar's. */
function fakeActions(extra: Partial<ReportActions> = {}) {
  const saved: FeedbackInput[] = [];
  const rows: ReportFeedback[] = [];
  const actions: ReportActions = {
    feedback: {
      runFor: (section) => `run-${section}`,
      get: (section, runId, itemKey) =>
        rows.find((r) => r.section === section && r.runId === runId && r.itemKey === itemKey),
      save: async (input) => {
        saved.push(input);
        const at = rows.findIndex(
          (r) => r.itemKey === input.itemKey && r.section === input.section,
        );
        const prev = at >= 0 ? rows[at] : undefined;
        const row: ReportFeedback = {
          id: prev?.id ?? String(rows.length),
          runId: input.runId,
          section: input.section,
          kind: input.kind,
          itemKey: input.itemKey,
          verdict: input.verdict === undefined ? (prev?.verdict ?? null) : input.verdict,
          rating: input.rating ?? null,
          reason: input.reason ?? null,
          actions: [...(prev?.actions ?? []), ...(input.action ? [input.action] : [])],
          updatedAt: "",
        };
        if (at >= 0) rows[at] = row;
        else rows.push(row);
      },
    },
    ...extra,
  };
  return { actions, saved };
}

const buttonsIn = (el: Element, label: string) =>
  [...el.querySelectorAll("button")].filter((b) => b.textContent === label);

function typeInto(el: HTMLTextAreaElement | HTMLInputElement | null, value: string) {
  if (!el) throw new Error("no field");
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The list item holding `text`, so a test acts on that item's own buttons. */
function itemWith(host: HTMLElement, text: string): HTMLElement {
  const li = [...host.querySelectorAll("li")].reverse().find((l) => l.textContent?.includes(text));
  if (!li) throw new Error(`no item with ${text}`);
  return li;
}

describe("report item feedback", () => {
  it("keeps a rejection's reason, against the run that wrote the section", async () => {
    const { actions, saved } = fakeActions();
    const { host, unmount } = await mountForInteraction(
      createElement(VerificationReportView, {
        report,
        onOpen: { open: () => {}, canOpen: () => true },
        actions,
      }),
    );
    try {
      const concern = itemWith(host, "Voice keeps sending");
      buttonsIn(concern, "Reject…")[0]?.click();
      await waitFor(() => concern.querySelector("textarea") !== null, "the reason box");
      typeInto(concern.querySelector("textarea"), "Unmount stops the mic.");
      buttonsIn(concern, "Reject")[0]?.click();
      await waitFor(() => saved.length === 1, "the save");
      expect(saved[0]).toMatchObject({
        runId: "run-risk",
        section: "risk",
        kind: "concern",
        verdict: "rejected",
        reason: "Unmount stops the mic.",
        item: { title: "Voice keeps sending", path: "src/chat.tsx", line: 202 },
      });
    } finally {
      unmount();
    }
  });

  it("rerates a finding's severity, and a risk to none", async () => {
    const { actions, saved } = fakeActions();
    const { host, unmount } = await mountForInteraction(
      createElement(VerificationReportView, {
        report,
        onOpen: { open: () => {}, canOpen: () => true },
        actions,
      }),
    );
    try {
      const finding = itemWith(host, "Toggle untested");
      buttonsIn(finding, "Change rating…")[0]?.click();
      await waitFor(() => finding.querySelector("select") !== null, "the rating picker");
      const select = finding.querySelector("select") as HTMLSelectElement;
      // The rating it already has isn't offered.
      expect([...select.options].map((o) => o.value)).toEqual(["", "low", "high"]);
      select.value = "low";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await waitFor(() => !buttonsIn(finding, "Save")[0]?.disabled, "save enabled");
      buttonsIn(finding, "Save")[0]?.click();
      await waitFor(() => saved.length === 1, "the save");
      expect(saved[0]).toMatchObject({
        section: "tests",
        kind: "finding",
        verdict: "rerated",
        rating: "low",
        item: { rating: "medium" },
      });
    } finally {
      unmount();
    }
  });

  it("lets a must-read's flag be posted, and records the post", async () => {
    const posted: string[] = [];
    const { actions, saved } = fakeActions({
      poster: {
        toPr: async (f) => {
          posted.push(`${f.path}:${f.line} ${f.title}`);
          return undefined;
        },
      },
    });
    const { host, unmount } = await mountForInteraction(
      createElement(VerificationReportView, {
        report,
        onOpen: { open: () => {}, canOpen: () => true },
        actions,
      }),
    );
    try {
      expect(textOf(host.innerHTML)).toContain("Looks off");
      const flag = itemWith(host, "Old proposal isn't cleared");
      buttonsIn(flag, "Post to PR")[0]?.click();
      await waitFor(() => saved.length === 1, "the recorded post");
      expect(posted).toEqual(["src/panel.tsx:69 Old proposal isn't cleared on re-parse"]);
      expect(saved[0]).toMatchObject({
        section: "summary",
        kind: "mustReadFlag",
        action: "posted-pr",
      });
    } finally {
      unmount();
    }
  });

  it("asks a follow-up about the item's lines, with the item as context", async () => {
    const asked: { target: AskTarget; question: string }[] = [];
    const { actions, saved } = fakeActions({
      ask: async (target, question) => {
        asked.push({ target, question });
        return "Yes: nothing clears it.";
      },
    });
    const { host, unmount } = await mountForInteraction(
      createElement(VerificationReportView, {
        report,
        onOpen: { open: () => {}, canOpen: () => true },
        actions,
      }),
    );
    try {
      const flag = itemWith(host, "Old proposal isn't cleared");
      buttonsIn(flag, "Ask a follow-up")[0]?.click();
      await waitFor(() => flag.querySelector("input") !== null, "the question box");
      typeInto(flag.querySelector("input"), "Is this real?");
      await waitFor(() => !buttonsIn(flag, "Ask")[0]?.disabled, "ask enabled");
      buttonsIn(flag, "Ask")[0]?.click();
      await waitFor(() => textOf(flag.innerHTML).includes("nothing clears it"), "the answer");
      expect(asked[0]).toEqual({
        target: {
          path: "src/panel.tsx",
          startLine: 69,
          endLine: 69,
          about: "Looks off: Old proposal isn't cleared on re-parse\nParse and confirm states",
        },
        question: "Is this real?",
      });
      await waitFor(() => saved.some((s) => s.action === "asked"), "the recorded question");
    } finally {
      unmount();
    }
  });

  it("shows what the reviewer said, and undoes it", async () => {
    const { actions, saved } = fakeActions();
    const { host, unmount } = await mountForInteraction(
      createElement(VerificationReportView, {
        report,
        onOpen: { open: () => {}, canOpen: () => true },
        actions,
      }),
    );
    try {
      const concern = itemWith(host, "Voice keeps sending");
      buttonsIn(concern, "Accept risk")[0]?.click();
      await waitFor(
        () => textOf(concern.innerHTML).includes("You accepted this risk"),
        "the verdict",
      );
      expect(saved[0]).toMatchObject({ verdict: "accepted", kind: "concern" });
      buttonsIn(concern, "Undo")[0]?.click();
      await waitFor(() => buttonsIn(concern, "Accept risk").length === 1, "the buttons back");
      expect(saved[1]).toMatchObject({ verdict: null });
    } finally {
      unmount();
    }
  });
});
