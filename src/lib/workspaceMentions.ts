import { useMemo } from "react";
import { useCachedResource } from "./resourceCache";
import { listWorkspaces, WORKSPACES_KEY, type WorkspaceSummary } from "./workspaces";

/**
 * Heads-down mode refers to workspaces by their id, a UUID. These helpers turn
 * an id the user has a workspace for into a link that opens it, labelled with
 * the workspace's name. An id that matches no workspace is left as written.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const WORKSPACE_SCHEME = "yarvis://workspace/";

/** Workspace names by id. */
export type WorkspaceNames = ReadonlyMap<string, string>;

const NO_WORKSPACES: WorkspaceSummary[] = [];

/** The names of the user's workspaces, read through the Workspaces tab's cache. */
export function useWorkspaceNames(): WorkspaceNames {
  const workspaces = useCachedResource<WorkspaceSummary[]>(WORKSPACES_KEY, listWorkspaces);
  const list = workspaces.data ?? NO_WORKSPACES;
  return useMemo(() => new Map(list.map((w) => [w.id.toLowerCase(), w.name])), [list]);
}

export function workspaceLink(id: string): string {
  return `${WORKSPACE_SCHEME}${id}`;
}

/** The workspace id a `yarvis://workspace/<id>` link names, or null for any other link. */
export function parseWorkspaceLink(href: string | undefined): string | null {
  if (!href?.startsWith(WORKSPACE_SCHEME)) return null;
  const id = href.slice(WORKSPACE_SCHEME.length);
  return new RegExp(`^${UUID.source}$`, "i").test(id) ? id.toLowerCase() : null;
}

export type MentionSegment = string | { workspaceId: string; name: string };

/** Splits text around the ids of known workspaces. */
export function splitWorkspaceMentions(text: string, names: WorkspaceNames): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(UUID)) {
    const id = match[0].toLowerCase();
    const name = names.get(id);
    if (name === undefined) continue;
    if (match.index > last) segments.push(text.slice(last, match.index));
    segments.push({ workspaceId: id, name });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push(text.slice(last));
  return segments;
}

// The few mdast shapes the plugin touches; the package's types aren't a dependency here.
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

function linkNode(workspaceId: string, name: string): MdNode {
  return {
    type: "link",
    url: workspaceLink(workspaceId),
    children: [{ type: "text", value: name }],
  };
}

function replaceMentions(node: MdNode, names: WorkspaceNames): void {
  // Text that is already a link keeps the link it has.
  if (!node.children || node.type === "link" || node.type === "linkReference") return;
  node.children = node.children.flatMap((child): MdNode[] => {
    // A bare id in backticks becomes the link; code with more in it stays code.
    if (child.type === "inlineCode" && child.value) {
      const segments = splitWorkspaceMentions(child.value.trim(), names);
      const only = segments[0];
      return segments.length === 1 && typeof only !== "string"
        ? [linkNode(only.workspaceId, only.name)]
        : [child];
    }
    if (child.type === "text" && child.value) {
      return splitWorkspaceMentions(child.value, names).map((segment) =>
        typeof segment === "string"
          ? { type: "text", value: segment }
          : linkNode(segment.workspaceId, segment.name),
      );
    }
    replaceMentions(child, names);
    return [child];
  });
}

/** A remark plugin that links the ids of known workspaces. */
export function remarkWorkspaceMentions(names: WorkspaceNames) {
  return () => (tree: MdNode) => {
    if (names.size > 0) replaceMentions(tree, names);
  };
}
