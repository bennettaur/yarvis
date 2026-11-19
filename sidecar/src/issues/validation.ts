import { z } from "zod";
import { noTraversal } from "../pr/codeTools.ts";

/**
 * Same owner/repo validation the PR routes use — these params are interpolated
 * into `${owner}/${repo}/...` GitHub API paths, so they must not smuggle extra
 * path segments.
 */
export const ownerName = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "invalid github owner");
// `.` and `..` are legal GitHub repo characters, so the charset regex admits a
// whole dot segment. Nothing can deliver one over HTTP today — URL parsing
// collapses it before the router matches, and the request 404s — but this value
// is interpolated into a GitHub API path, where a surviving `..` would resolve
// to a different endpoint with the user's token attached. The guard sits with
// the other validation rather than resting on a normalization step happening
// somewhere else, which is the boundary codeTools.ts draws for the same reason.
export const repoName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "invalid github repo")
  .refine(noTraversal, "invalid github repo");
