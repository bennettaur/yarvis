import { Fragment } from "react";
import { requestOpenWorkspace } from "../lib/nav";
import { splitWorkspaceMentions, type WorkspaceNames } from "../lib/workspaceMentions";

/** Plain text with the id of each known workspace shown as a link to it, by name. */
export default function WorkspaceMentionText({
  text,
  names,
}: {
  text: string;
  names: WorkspaceNames;
}) {
  return (
    <>
      {splitWorkspaceMentions(text, names).map((segment, i) =>
        typeof segment === "string" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments come from one string and never reorder
          <Fragment key={i}>{segment}</Fragment>
        ) : (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: the same workspace can be named twice
            key={i}
            type="button"
            title={`Open workspace ${segment.workspaceId}`}
            onClick={() => requestOpenWorkspace({ id: segment.workspaceId })}
            className="text-sky-400 hover:underline"
          >
            {segment.name}
          </button>
        ),
      )}
    </>
  );
}
