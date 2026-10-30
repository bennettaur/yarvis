import { useMemo } from "react";
import { useCachedResource } from "./resourceCache";
import { listWorkspaces, WORKSPACES_KEY, type WorkspaceSummary } from "./workspaces";

/**
 * Heads-down mode refers to workspaces by their id, a UUID. These helpers turn
 * an id the user has a workspace for into a link that opens it, labelled with
 * the workspace's name. An id that matches no workspace is left as written.
 */

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// A standalone id only: one inside a path or URL is part of that, not a mention.
const MENTION = new RegExp(`(?<![\\w/-])${UUID_PATTERN}(?![\\w/-])`, "gi");
const EXACT_UUID = new RegExp(`^${UUID_PATTERN}$`, "i");
const WORKSPACE_SCHEME = "yarvis://workspace/";

/** Workspace names, keyed by lowercased id. */
export type WorkspaceNames = ReadonlyMap<string, string>;

/** A stable empty list, so the names map isn't rebuilt while the list loads. */
const NO_WORKSPACES: WorkspaceSummary[] = [];

/** The names of the user's workspaces, read through the Workspaces tab's cache. */
export function useWorkspaceNames(): WorkspaceNames {
  const workspaces = useCachedResource<WorkspaceSummary[]>(WORKSPACES_KEY, listWorkspaces);
  const list = workspaces.data ?? NO_WORKSPACES;
  return useMemo(() => new Map(list.map((w) => [w.id.toLowerCase(), w.name])), [list]);
}

function workspaceLink(id: string): string {
  return `${WORKSPACE_SCHEME}${id}`;
}

/** The workspace id a `yarvis://workspace/<id>` link names, or null for any other link. */
export function parseWorkspaceLink(href: string | undefined): string | null {
  if (!href?.startsWith(WORKSPACE_SCHEME)) return null;
  const id = href.slice(WORKSPACE_SCHEME.length);
  return EXACT_UUID.test(id) ? id.toLowerCase() : null;
}

type MentionSegment = string | { workspaceId: string; name: string };

/** Splits text around the ids of known workspaces. */
export function splitWorkspaceMentions(text: string, names: WorkspaceNames): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
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
  if (!node.children || node.type === "linkReference") return;
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type === "link") {
      // A workspace link the text wrote itself opens only a known workspace,
      // and shows its real name rather than whatever label the text chose.
      const id = parseWorkspaceLink(child.url);
      if (id === null) return [child];
      const name = names.get(id);
      return name === undefined ? (child.children ?? []) : [linkNode(id, name)];
    }
    // A bare id in backticks becomes the link; code with more in it stays code.
    if (child.type === "inlineCode" && child.value) {
      const [first, ...rest] = splitWorkspaceMentions(child.value.trim(), names);
      const isBareKnownId = first !== undefined && typeof first !== "string" && rest.length === 0;
      return isBareKnownId ? [linkNode(first.workspaceId, first.name)] : [child];
    }
    if (child.type === "text" && child.value) {
      const segments = splitWorkspaceMentions(child.value, names);
      if (segments.length === 1 && typeof segments[0] === "string") return [child];
      return segments.map((segment) =>
        typeof segment === "string"
          ? { type: "text", value: segment }
          : linkNode(segment.workspaceId, segment.name),
      );
    }
    replaceMentions(child, names);
    return [child];
  });
}

/**
 * A remark plugin that links the ids of known workspaces. Remark calls the
 * returned attacher to get the tree transform.
 */
export function remarkWorkspaceMentions(names: WorkspaceNames) {
  return () => (tree: MdNode) => {
    replaceMentions(tree, names);
  };
}
