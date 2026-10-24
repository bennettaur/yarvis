import type { ReactNode } from "react";
import CommitTab from "./CommitTab";
import DiffTab from "./DiffTab";
import FileTab from "./FileTab";
import GuideTab from "./GuideTab";
import MutationTab from "./MutationTab";
import SinceFileTab from "./SinceFileTab";
import SinceReviewTab from "./SinceReviewTab";
import { ChecksTab, CommentsTab, DescriptionTab, ReviewersTab } from "./StaticTabs";
import type { DynamicTabKind, StaticTabKind, TabContext, TabSpec } from "./types";
import VerificationTab from "./VerificationTab";

export const STATIC_TAB_LABEL: Record<StaticTabKind, string> = {
  description: "Description",
  reviewers: "Reviewers",
  checks: "Checks",
  comments: "Comments",
  "since-review": "Since last review",
  guide: "Guided review",
  verification: "Verification",
  mutation: "Mutation testing",
};

/** The mark before a dynamic tab's title, so a diff, an interdiff and a commit tell apart. */
export const TAB_GLYPH: Partial<Record<DynamicTabKind, { glyph: string; className: string }>> = {
  diff: { glyph: "±", className: "text-sky-400" },
  "since-file": { glyph: "Δ", className: "text-amber-400" },
  commit: { glyph: "●", className: "text-violet-400" },
};

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The title a tab shows in the strip; a file's full path goes in its tooltip. */
export function tabTitle(spec: TabSpec): string {
  switch (spec.kind) {
    case "diff":
    case "file":
    case "since-file":
      return basename(spec.path);
    case "commit":
      return spec.subject ? `${spec.sha.slice(0, 7)} ${spec.subject}` : spec.sha.slice(0, 7);
    default:
      return STATIC_TAB_LABEL[spec.kind];
  }
}

/** The tooltip: where a file tab points, or what a commit tab is. */
export function tabTooltip(spec: TabSpec): string {
  switch (spec.kind) {
    case "diff":
    case "file":
      return spec.path;
    case "since-file":
      return `${spec.path} — since your review`;
    case "commit":
      return spec.subject ? `${spec.sha} — ${spec.subject}` : spec.sha;
    default:
      return STATIC_TAB_LABEL[spec.kind];
  }
}

/** The tab's body for its spec. */
export function renderTab(spec: TabSpec, ctx: TabContext): ReactNode {
  switch (spec.kind) {
    case "diff":
      return (
        <DiffTab
          ctx={ctx}
          path={spec.path}
          revealLine={spec.revealLine}
          revealNonce={spec.revealNonce}
        />
      );
    case "file":
      return (
        <FileTab
          ctx={ctx}
          path={spec.path}
          revealLine={spec.revealLine}
          revealNonce={spec.revealNonce}
        />
      );
    case "since-file":
      return <SinceFileTab ctx={ctx} path={spec.path} from={spec.from} />;
    case "commit":
      return <CommitTab ctx={ctx} sha={spec.sha} subject={spec.subject} />;
    case "description":
      return <DescriptionTab ctx={ctx} />;
    case "reviewers":
      return <ReviewersTab ctx={ctx} />;
    case "checks":
      return <ChecksTab ctx={ctx} />;
    case "comments":
      return <CommentsTab ctx={ctx} />;
    case "since-review":
      return <SinceReviewTab ctx={ctx} />;
    case "guide":
      return <GuideTab ctx={ctx} />;
    case "verification":
      return <VerificationTab ctx={ctx} />;
    case "mutation":
      return <MutationTab ctx={ctx} />;
  }
}
