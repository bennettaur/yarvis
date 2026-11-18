import { z } from "zod";

// Project key + number, e.g. "PROJ-45". Interpolated into JIRA API paths, so it
// must not smuggle extra path segments. Case-insensitive; JIRA keys are upper.
export const issueKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*-\d+$/, "invalid jira issue key");
