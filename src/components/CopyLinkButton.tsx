import { clipboardSafeUrl } from "../lib/clipboard";
import CopyButton, { type CopyIconKind } from "./CopyButton";

/**
 * Copies a provider-supplied link — a PR, a check, an issue. Renders nothing
 * for a URL `openExternal` would refuse to open: the copy path hands the link
 * to someone else, so it can afford the scheme allowlist even less than the
 * open path can.
 */
export default function CopyLinkButton({
  url,
  subject,
  title,
  icon,
  className = "",
}: {
  url: string | null | undefined;
  /** Noun phrase naming the link, e.g. "PR link" or "issue link". */
  subject: string;
  /** Overrides the tooltip and accessible name, e.g. to name the target. */
  title?: string;
  /** Idle glyph; pass "link" where this sits next to a copy-path button. */
  icon?: CopyIconKind;
  /** Extra classes from the host, e.g. hover-reveal in a dense list row. */
  className?: string;
}) {
  const safe = clipboardSafeUrl(url);
  if (!safe) return null;
  return (
    <CopyButton value={safe} subject={subject} title={title} icon={icon} className={className} />
  );
}
