import type { ReactNode } from "react";
import DiffTab from "./DiffTab";
import FileTab from "./FileTab";
import GuideTab from "./GuideTab";
import MutationTab from "./MutationTab";
import { ChecksTab, CommentsTab, DescriptionTab, ReviewersTab } from "./StaticTabs";
import type { StaticTabKind, TabContext, TabSpec } from "./types";
import VerificationTab from "./VerificationTab";

export const STATIC_TAB_LABEL: Record<StaticTabKind, string> = {
  description: "Description",
  reviewers: "Reviewers",
  checks: "Checks",
  comments: "Comments",
  guide: "Guided review",
  verification: "Verification",
  mutation: "Mutation testing",
};

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The title a tab shows in the strip; a file's full path goes in its tooltip. */
export function tabTitle(spec: TabSpec): string {
  return spec.kind === "diff" || spec.kind === "file"
    ? basename(spec.path)
    : STATIC_TAB_LABEL[spec.kind];
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
    case "description":
      return <DescriptionTab ctx={ctx} />;
    case "reviewers":
      return <ReviewersTab ctx={ctx} />;
    case "checks":
      return <ChecksTab ctx={ctx} />;
    case "comments":
      return <CommentsTab ctx={ctx} />;
    case "guide":
      return <GuideTab ctx={ctx} />;
    case "verification":
      return <VerificationTab ctx={ctx} />;
    case "mutation":
      return <MutationTab ctx={ctx} />;
  }
}
