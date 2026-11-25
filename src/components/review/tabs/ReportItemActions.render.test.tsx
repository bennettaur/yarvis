import { describe, expect, it } from "bun:test";
import { createElement, useState } from "react";
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

interface HostOptions {
  extra?: Partial<ReportActions>;
  /** Rows the store starts with, as if loaded from the sidecar. */
  initial?: ReportFeedback[];
  currentSections?: ReadonlySet<string>;
  /** Makes every save fail. */
  failSaves?: boolean;
}

/**
 * The report with a feedback store in memory that re-renders on a save, as
 * the tab's cache does, and is keyed like the sidecar's table.
 */
function mountReport(options: HostOptions = {}) {
  const saved: FeedbackInput[] = [];
  function Host() {
    const [rows, setRows] = useState<ReportFeedback[]>(options.initial ?? []);
    const actions: ReportActions = {
      feedback: {
        runFor: (section) => `run-${section}`,
        get: (section, runId, itemKey) =>
          rows.find((r) => r.section === section && r.runId === runId && r.itemKey === itemKey),
        save: async (input) => {
          saved.push(input);
          if (options.failSaves) throw new Error("sidecar is down");
          setRows((current) => {
            const prev = current.find(
              (r) =>
                r.section === input.section &&
                r.runId === input.runId &&
                r.itemKey === input.itemKey,
            );
            const keep = input.verdict === undefined;
            const row: ReportFeedback = {
              id: prev?.id ?? String(current.length),
              runId: input.runId,
              section: input.section,
              kind: input.kind,
              itemKey: input.itemKey,
              verdict: keep ? (prev?.verdict ?? null) : (input.verdict ?? null),
              rating: keep ? (prev?.rating ?? null) : (input.rating ?? null),
              reason: keep ? (prev?.reason ?? null) : (input.reason ?? null),
              actions: [...(prev?.actions ?? []), ...(input.action ? [input.action] : [])],
              updatedAt: "",
            };
            return [row, ...current.filter((r) => r !== prev)];
          });
        },
      },
      ...options.extra,
    };
    return createElement(VerificationReportView, {
      report,
      onOpen: { open: () => {}, canOpen: () => true },
      actions,
      currentSections: options.currentSections,
    });
  }
  return mountForInteraction(createElement(Host)).then((mounted) => ({ ...mounted, saved }));
}

const buttonsIn = (el: Element, label: string) =>
  [...el.querySelectorAll("button")].filter((b) => b.textContent === label);

/** Clicks the item's button, failing at once when it isn't there. */
function click(el: Element, label: string) {
  const button = buttonsIn(el, label)[0];
  if (!button) throw new Error(`no "${label}" button`);
  button.click();
}

function typeInto(el: HTMLTextAreaElement | HTMLInputElement | null, value: string) {
  if (!el) throw new Error("no field");
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The innermost list item holding `text`, so a test acts on that item's own buttons. */
function itemWith(host: HTMLElement, text: string): HTMLElement {
  const li = [...host.querySelectorAll("li")].reverse().find((l) => l.textContent?.includes(text));
  if (!li) throw new Error(`no item with ${text}`);
  return li;
}

const concernKey = JSON.stringify(["concern", "Voice keeps sending", "src/chat.tsx", 202]);

describe("report item feedback", () => {
  it("keeps a rejection's reason, against the run that wrote the section, and shows it", async () => {
    const { host, unmount, saved } = await mountReport();
    try {
      const concern = itemWith(host, "Voice keeps sending");
      click(concern, "Reject…");
      await waitFor(() => concern.querySelector("textarea") !== null, "the reason box");
      // A rejection with no reason can't be saved.
      expect(buttonsIn(concern, "Save rejection")[0]?.disabled).toBe(true);
      typeInto(concern.querySelector("textarea"), "Unmount stops the mic.");
      await waitFor(() => !buttonsIn(concern, "Save rejection")[0]?.disabled, "save enabled");
      click(concern, "Save rejection");
      await waitFor(() => textOf(concern.innerHTML).includes("You rejected this"), "the verdict");
      expect(textOf(concern.innerHTML)).toContain("Unmount stops the mic.");
      expect(saved[0]).toMatchObject({
        runId: "run-risk",
        section: "risk",
        kind: "concern",
        itemKey: concernKey,
        verdict: "rejected",
        reason: "Unmount stops the mic.",
        item: { title: "Voice keeps sending", path: "src/chat.tsx", line: 202 },
      });
    } finally {
      unmount();
    }
  });

  it("rerates a finding's severity, offering only the ratings it doesn't have", async () => {
    const { host, unmount, saved } = await mountReport();
    try {
      const finding = itemWith(host, "Toggle untested");
      click(finding, "Change rating…");
      await waitFor(() => finding.querySelector("select") !== null, "the rating picker");
      const select = finding.querySelector("select") as HTMLSelectElement;
      expect([...select.options].map((o) => o.value)).toEqual(["", "low", "high"]);
      select.value = "low";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await waitFor(() => !buttonsIn(finding, "Save rating")[0]?.disabled, "save enabled");
      click(finding, "Save rating");
      await waitFor(() => textOf(finding.innerHTML).includes("You rated it low"), "the verdict");
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
    const { host, unmount, saved } = await mountReport({
      extra: {
        poster: {
          toPr: async (f) => {
            posted.push(`${f.path}:${f.line} ${f.title}`);
            return undefined;
          },
        },
      },
    });
    try {
      expect(textOf(host.innerHTML)).toContain("Looks off");
      const flag = itemWith(host, "Old proposal isn't cleared");
      click(flag, "Post to PR");
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

  it("still shows a post as done when recording it fails", async () => {
    const { host, unmount, saved } = await mountReport({
      failSaves: true,
      extra: { poster: { toPr: async () => undefined } },
    });
    try {
      const concern = itemWith(host, "Voice keeps sending");
      click(concern, "Post to PR");
      await waitFor(() => saved.length === 1, "the attempt to record it");
      await waitFor(() => buttonsIn(concern, "Posted to PR")[0]?.disabled === true, "posted");
    } finally {
      unmount();
    }
  });

  it("keeps the reason typed when a rejection can't be saved", async () => {
    const { host, unmount } = await mountReport({ failSaves: true });
    try {
      const concern = itemWith(host, "Voice keeps sending");
      click(concern, "Reject…");
      await waitFor(() => concern.querySelector("textarea") !== null, "the reason box");
      typeInto(concern.querySelector("textarea"), "Wrong file.");
      await waitFor(() => !buttonsIn(concern, "Save rejection")[0]?.disabled, "save enabled");
      click(concern, "Save rejection");
      await waitFor(() => textOf(concern.innerHTML).includes("sidecar is down"), "the error");
      expect(concern.querySelector("textarea")?.value).toBe("Wrong file.");
    } finally {
      unmount();
    }
  });

  it("asks a follow-up about the item's lines, with the item as context", async () => {
    const asked: { target: AskTarget; question: string }[] = [];
    const { host, unmount, saved } = await mountReport({
      extra: {
        ask: async (target, question) => {
          asked.push({ target, question });
          return "Yes: nothing clears it.";
        },
      },
    });
    try {
      const flag = itemWith(host, "Old proposal isn't cleared");
      click(flag, "Ask a follow-up");
      await waitFor(() => flag.querySelector("input") !== null, "the question box");
      typeInto(flag.querySelector("input"), "Is this real?");
      await waitFor(() => !buttonsIn(flag, "Ask")[0]?.disabled, "ask enabled");
      click(flag, "Ask");
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

  it("shows a verdict loaded with the report, but not one given on an older run", async () => {
    const row = (runId: string, section: string, itemKey: string): ReportFeedback => ({
      id: runId,
      runId,
      section,
      kind: "concern",
      itemKey,
      verdict: "accepted",
      rating: null,
      reason: null,
      actions: [],
      updatedAt: "",
    });
    const findingKey = JSON.stringify(["finding", "Toggle untested", "src/chat.tsx", 104]);
    const { host, unmount } = await mountReport({
      initial: [row("run-risk", "risk", concernKey), row("run-old", "tests", findingKey)],
    });
    try {
      expect(textOf(itemWith(host, "Voice keeps sending").innerHTML)).toContain(
        "You accepted this risk",
      );
      expect(buttonsIn(itemWith(host, "Toggle untested"), "Agree")).toHaveLength(1);
    } finally {
      unmount();
    }
  });

  it("lets an older head's item be judged, but not posted or asked about", async () => {
    const { host, unmount } = await mountReport({
      currentSections: new Set(["summary"]),
      extra: { poster: { toPr: async () => undefined }, ask: async () => "" },
    });
    try {
      const concern = itemWith(host, "Voice keeps sending");
      expect(buttonsIn(concern, "Accept risk")).toHaveLength(1);
      expect(buttonsIn(concern, "Post to PR")).toHaveLength(0);
      expect(buttonsIn(concern, "Ask a follow-up")).toHaveLength(0);
    } finally {
      unmount();
    }
  });

  it("accepts a risk, then undoes it", async () => {
    const { host, unmount, saved } = await mountReport();
    try {
      const concern = itemWith(host, "Voice keeps sending");
      click(concern, "Accept risk");
      await waitFor(
        () => textOf(concern.innerHTML).includes("You accepted this risk"),
        "the verdict",
      );
      click(concern, "Undo");
      await waitFor(() => buttonsIn(concern, "Accept risk").length === 1, "the buttons back");
      expect(saved.map((s) => s.verdict)).toEqual(["accepted", null]);
    } finally {
      unmount();
    }
  });
});
