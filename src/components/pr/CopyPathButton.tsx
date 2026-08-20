import { clipboardSafePath } from "../../lib/clipboard";
import CopyButton from "../CopyButton";

/**
 * Copies a changed file's repo-relative path to the system clipboard — the
 * thing a reader reaches for when they want to open the file in an editor or
 * quote it to an agent. It lives next to the filename in the PR file list, the
 * diff header and the workspace's file lists, so it is reachable from wherever
 * the reader happens to be.
 *
 * A path needs sanitizing before it goes anywhere near a shell or a prompt (see
 * `clipboardSafePath`), which is what this adds over a bare {@link CopyButton}.
 */
export default function CopyPathButton({
  path,
  className = "",
}: {
  path: string;
  /** Extra classes from the host, e.g. hover-reveal in a dense list row. */
  className?: string;
}) {
  return (
    <CopyButton
      value={() => clipboardSafePath(path)}
      subject="path"
      title={`Copy path ${path}`}
      className={className}
    />
  );
}
