import { z } from "zod";
import type { AttentionNavTarget } from "../db/schema.ts";
import type { PrRef } from "../pr/types.ts";

/**
 * Where clicking the item lands. A workspace's pinned Claude session keeps the
 * `workspace-claude` target (the frontend already knows how to focus that tab);
 * anything else is a specific terminal session, so we address the tab directly
 * and carry the workspace along when there is one.
 */
export function navTargetFor(sessionKey: string, workspaceId?: string): AttentionNavTarget {
  if (workspaceId && sessionKey === `ws-claude:${workspaceId}`) {
    return { type: "workspace-claude", workspaceId };
  }
  return { type: "terminal", sessionKey, ...(workspaceId ? { workspaceId } : {}) };
}

/** Opens a pull request on the PRs tab, whichever provider it is on. */
export function prNavTarget(ref: PrRef): AttentionNavTarget {
  return ref.provider === "github"
    ? { type: "pr", owner: ref.owner, repo: ref.repo, number: ref.number }
    : { type: "azure-pr", org: ref.org, project: ref.project, repo: ref.repo, prId: ref.prId };
}

const id = z.string().uuid();
const name = z.string().min(1).max(200);

/** An {@link AttentionNavTarget} as an agent may hand one in. */
export const navTargetSchema: z.ZodType<AttentionNavTarget> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workspace-claude"), workspaceId: id }),
  z.object({ type: z.literal("workspace"), workspaceId: id }),
  z.object({
    type: z.literal("terminal"),
    sessionKey: z.string().min(1).max(256),
    workspaceId: id.optional(),
  }),
  z.object({ type: z.literal("chat"), sessionId: id.optional() }),
  z.object({
    type: z.literal("pr"),
    owner: name,
    repo: name,
    number: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("azure-pr"),
    org: name,
    project: name,
    repo: name,
    prId: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("issue"),
    provider: name,
    sourceKey: name,
    externalId: name,
  }),
  z.object({ type: z.literal("task"), taskId: id }),
  z.object({ type: z.literal("heads-down") }),
  z.object({
    type: z.literal("review-workspace"),
    workspaceId: id,
    prId: id,
    tab: z.literal("verification").optional(),
  }),
]);
