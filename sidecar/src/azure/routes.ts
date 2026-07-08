import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { describeError } from "../llm/errors.ts";
import { AzureDevOpsClient, type AzureRef, isAllowedAzureOrgUrl } from "./client.ts";
import {
  addStar,
  createFilter,
  deleteFilter,
  listFilters,
  listStars,
  removeStar,
} from "./service.ts";

/**
 * Azure DevOps project and repository names allow letters, numbers, spaces,
 * dots, hyphens, and underscores — a wider set than GitHub. Rather than an
 * allowlist regex, validate length and reject the characters that would let a
 * value smuggle extra path segments (`/`, `\`) or traverse (`..`) once it is
 * interpolated into an API path.
 */
const segment = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => !s.includes("/") && !s.includes("\\") && !s.includes(".."), "invalid name");

/** A repo-relative file path: slashes allowed, traversal rejected. */
const filePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => !s.split("/").includes(".."), "invalid path");

const filterSchema = z.object({
  name: z.string().min(1),
  scope: z.enum(["mine", "review"]),
  project: z.string().min(1).nullish(),
});

const starSchema = z.object({
  org: segment,
  project: segment,
  repo: segment,
  prId: z.number().int(),
  title: z.string().nullish(),
  url: z.string().nullish(),
});

const commentSchema = z.object({
  path: filePath,
  line: z.number().int().min(1),
  body: z.string().min(1),
  side: z.enum(["RIGHT", "LEFT"]).optional(),
});

/**
 * Azure votes are an enum on a small numeric set; reject anything else so a
 * caller can't push exotic values into the upstream call.
 */
const voteSchema = z.object({
  vote: z
    .number()
    .int()
    .refine((v) => [-10, -5, 0, 5, 10].includes(v), "invalid vote"),
  body: z.string().max(65_536).optional(),
});

/** Azure DevOps PR dashboard routes, mounted under /api/azure. */
export function createAzureRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) {
      return c.json({ error: "database not configured" }, 503);
    }
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  /** Why the Azure client could not be built — surfaced to the PRs page so it can
   *  tell the user exactly which secret to fix rather than a single generic hint. */
  type ClientGate =
    | { ok: true; client: AzureDevOpsClient }
    | { ok: false; reason: "missing_token" | "missing_org_url" | "invalid_org_url" };

  const gateClient = (): ClientGate => {
    const { azureDevopsToken, azureDevopsOrgUrl } = config.secrets;
    if (!azureDevopsToken) return { ok: false, reason: "missing_token" };
    if (!azureDevopsOrgUrl) return { ok: false, reason: "missing_org_url" };
    // A malformed or non-Azure org URL is rejected so the PAT is never sent to an
    // unexpected host.
    if (!isAllowedAzureOrgUrl(azureDevopsOrgUrl)) return { ok: false, reason: "invalid_org_url" };
    return { ok: true, client: new AzureDevOpsClient(azureDevopsToken, azureDevopsOrgUrl) };
  };

  /**
   * Resolves the Azure client for a request, or returns a 400 whose `reason` names
   * which secret is missing or invalid. Only an invalid org URL is logged — a
   * missing token or missing org URL is the common state for setups that only
   * use GitHub and would just be noise. Invalid means the user *did* configure
   * it but the value won't work, so it's a typo worth surfacing in logs.
   */
  const requireClient = (c: Context): AzureDevOpsClient | Response => {
    const gate = gateClient();
    if (gate.ok) return gate.client;
    if (gate.reason === "invalid_org_url") {
      console.warn(`[azure] invalid org URL: ${config.secrets.azureDevopsOrgUrl}`);
    }
    return c.json({ error: "azure devops not configured", reason: gate.reason }, 400);
  };

  /**
   * Logs an upstream Azure failure in full and returns a sanitized response. A
   * 401/403 means Azure rejected the PAT itself (expired or missing the Code
   * (Read) scope), which the PRs page reports distinctly from an unconfigured
   * token. The route path is used as the log context so every call site is covered
   * without threading a label through each handler.
   */
  const upstreamError = (c: Context, e: unknown): Response => {
    const detail = describeError(e);
    const status = /-> (\d{3})\b/.exec(detail)?.[1];
    const unauthorized = status === "401" || status === "403";
    console.error(`[azure] ${c.req.method} ${c.req.path} failed:`, detail);
    return c.json(
      {
        error: unauthorized ? "azure devops rejected the token" : "azure devops request failed",
        reason: unauthorized ? "unauthorized" : "upstream_error",
      },
      unauthorized ? 401 : 502,
    );
  };

  function parsePrParams(
    project: string,
    repo: string,
    rawPrId: string,
  ): AzureRef | { error: unknown } {
    const parsed = z.object({ project: segment, repo: segment }).safeParse({ project, repo });
    if (!parsed.success) return { error: parsed.error.flatten() };
    const prId = Number(rawPrId);
    if (!Number.isInteger(prId) || prId < 1) return { error: "bad pull request id" };
    return { project: parsed.data.project, repo: parsed.data.repo, prId };
  }

  // --- Live Azure DevOps queries (require a token + org URL) ---

  router.get("/viewer", async (c) => {
    const az = requireClient(c);
    if (az instanceof Response) return az;
    try {
      return c.json(await az.viewer());
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  router.get("/search", async (c) => {
    const az = requireClient(c);
    if (az instanceof Response) return az;
    const scope = c.req.query("scope") === "review" ? "review" : "mine";
    const project = c.req.query("project") || undefined;
    try {
      return c.json(await az.search(scope, project));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  router.get("/pr/:project/:repo/:prId", async (c) => {
    const az = requireClient(c);
    if (az instanceof Response) return az;
    const ref = parsePrParams(c.req.param("project"), c.req.param("repo"), c.req.param("prId"));
    if ("error" in ref) return c.json({ error: ref.error }, 400);
    try {
      return c.json(await az.prStatus(ref));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  router.get("/pr/:project/:repo/:prId/detail", async (c) => {
    const az = requireClient(c);
    if (az instanceof Response) return az;
    const ref = parsePrParams(c.req.param("project"), c.req.param("repo"), c.req.param("prId"));
    if ("error" in ref) return c.json({ error: ref.error }, 400);
    try {
      return c.json(await az.prDetail(ref));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  // Changed-file list (no patches); diffs load per file via /file below.
  router.get("/pr/:project/:repo/:prId/files", async (c) => {
    const az = requireClient(c);
    if (az instanceof Response) return az;
    const ref = parsePrParams(c.req.param("project"), c.req.param("repo"), c.req.param("prId"));
    if ("error" in ref) return c.json({ error: ref.error }, 400);
    try {
      return c.json(await az.prFiles(ref));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  // One file's computed unified diff (lazy — fetched when its diff is opened).
  router.get("/pr/:project/:repo/:prId/file", async (c) => {
    const az = requireClient(c);
    if (az instanceof Response) return az;
    const ref = parsePrParams(c.req.param("project"), c.req.param("repo"), c.req.param("prId"));
    if ("error" in ref) return c.json({ error: ref.error }, 400);
    const path = filePath.safeParse(c.req.query("path"));
    if (!path.success) return c.json({ error: path.error.flatten() }, 400);
    try {
      return c.json(await az.prFileDiff(ref, path.data));
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  // Publish a draft PR (Azure clears the isDraft flag).
  router.post("/pr/:project/:repo/:prId/ready", async (c) => {
    const az = requireClient(c);
    if (az instanceof Response) return az;
    const ref = parsePrParams(c.req.param("project"), c.req.param("repo"), c.req.param("prId"));
    if ("error" in ref) return c.json({ error: ref.error }, 400);
    try {
      await az.markReady(ref);
      return c.json({ ok: true });
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  // Cast a vote on the PR (10=approve, -10=reject). Optional `body` is posted
  // as a PR-level comment thread so the user's note isn't dropped.
  router.post("/pr/:project/:repo/:prId/vote", async (c) => {
    const az = requireClient(c);
    if (az instanceof Response) return az;
    const ref = parsePrParams(c.req.param("project"), c.req.param("repo"), c.req.param("prId"));
    if ("error" in ref) return c.json({ error: ref.error }, 400);
    const parsed = voteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    if (parsed.data.vote === -10 && !parsed.data.body?.trim()) {
      return c.json({ error: "rejecting requires a body" }, 400);
    }
    try {
      await az.submitVote(ref, parsed.data.vote, parsed.data.body);
      return c.json({ ok: true }, 201);
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  router.post("/pr/:project/:repo/:prId/comments", async (c) => {
    const az = requireClient(c);
    if (az instanceof Response) return az;
    const ref = parsePrParams(c.req.param("project"), c.req.param("repo"), c.req.param("prId"));
    if ("error" in ref) return c.json({ error: ref.error }, 400);
    const parsed = commentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      await az.postComment(ref, parsed.data);
      return c.json({ ok: true }, 201);
    } catch (e) {
      return upstreamError(c, e);
    }
  });

  // --- Saved filters (database only) ---

  router.get("/filters", async (c) => c.json(await listFilters(db())));

  router.post("/filters", async (c) => {
    const parsed = filterSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(
      await createFilter(db(), parsed.data.name, parsed.data.scope, parsed.data.project ?? null),
      201,
    );
  });

  router.delete("/filters/:id", async (c) =>
    c.json({ deleted: await deleteFilter(db(), c.req.param("id")) }),
  );

  // --- Starred PRs (database only) ---

  router.get("/stars", async (c) => c.json(await listStars(db())));

  router.post("/stars", async (c) => {
    const parsed = starSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    await addStar(db(), parsed.data);
    return c.json({ ok: true }, 201);
  });

  router.delete("/stars/:org/:project/:repo/:prId", async (c) => {
    const ref = parsePrParams(c.req.param("project"), c.req.param("repo"), c.req.param("prId"));
    if ("error" in ref) return c.json({ error: ref.error }, 400);
    const org = segment.safeParse(c.req.param("org"));
    if (!org.success) return c.json({ error: org.error.flatten() }, 400);
    return c.json({
      deleted: await removeStar(db(), org.data, ref.project, ref.repo, ref.prId),
    });
  });

  return router;
}
