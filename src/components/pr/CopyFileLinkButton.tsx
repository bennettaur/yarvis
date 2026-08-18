import { prFileUrl } from "../../lib/pr/links";
import { refProviderName } from "../../lib/pr/ref";
import type { PrRef } from "../../lib/pr/types";
import CopyButton from "../CopyButton";

/**
 * Copies the provider's link to one file of a PR, pinned to the commit the PR
 * points at — what a reviewer pastes into Slack to point someone at code, as
 * opposed to the bare path {@link CopyPathButton} gives an editor or an agent.
 *
 * Renders nothing while the link can't be derived: before the head commit is
 * known, or when the PR's URL isn't the shape its provider uses. A guessed link
 * that lands on the wrong file is worse than no button.
 */
export default function CopyFileLinkButton({
  prRef,
  prUrl,
  headSha,
  path,
  className = "",
}: {
  prRef: PrRef;
  /** The PR's own web URL — every link here is derived from it. */
  prUrl: string;
  /** Commit the PR currently points at; empty until the detail loads. */
  headSha: string;
  path: string;
  /** Extra classes from the host, e.g. hover-reveal in a dense list row. */
  className?: string;
}) {
  const url = prFileUrl(prUrl, prRef.provider, headSha, path);
  if (!url) return null;
  return (
    <CopyButton
      value={url}
      subject="file link"
      title={`Copy the ${refProviderName(prRef)} link to ${path}`}
      className={className}
    />
  );
}
