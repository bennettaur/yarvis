import { z } from "zod";
import { areaPath, projectName } from "../azureBoards/validation.ts";

/**
 * Where a repo's tickets are filed. `repos.pullIssues` only says whether the
 * Issues tab shows the repo's GitHub issues; this says which tracker the agent
 * should file and move the repo's tickets in, which for some repos is not GitHub
 * at all.
 *
 * Azure Boards names a project and, optionally, an area path, but no org: every
 * Boards call goes to the one org URL configured in Settings, so an org stored
 * here could only disagree with it.
 */
export const repoTrackerSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("github") }),
  z.object({
    provider: z.literal("azure-boards"),
    project: projectName,
    areaPath: areaPath.optional(),
  }),
  z.object({
    provider: z.literal("jira"),
    projectKey: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "invalid JIRA project key"),
  }),
]);

export type RepoTracker = z.infer<typeof repoTrackerSchema>;
