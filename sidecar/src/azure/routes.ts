import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { AzureDevOpsClient, type AzureRef } from "./client.ts";
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
  const client = () =>
    config.secrets.azureDevopsToken && config.secrets.azureDevopsOrgUrl
      ? new AzureDevOpsClient(config.secrets.azureDevopsToken, config.secrets.azureDevopsOrgUrl)
      : null;

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
    const az = client();
    if (!az) return c.json({ error: "azure devops not configured" }, 400);
    try {
      return c.json(await az.viewer());
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  router.get("/search", async (c) => {
    const az = client();
    if (!az) return c.json({ error: "azure devops not configured" }, 400);
    const scope = c.req.query("scope") === "review" ? "review" : "mine";
    const project = c.req.query("project") || undefined;
    try {
      return c.json(await az.search(scope, project));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  router.get("/pr/:project/:repo/:prId", async (c) => {
    const az = client();
    if (!az) return c.json({ error: "azure devops not configured" }, 400);
    const ref = parsePrParams(c.req.param("project"), c.req.param("repo"), c.req.param("prId"));
    if ("error" in ref) return c.json({ error: ref.error }, 400);
    try {
      return c.json(await az.prStatus(ref));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  router.get("/pr/:project/:repo/:prId/detail", async (c) => {
    const az = client();
    if (!az) return c.json({ error: "azure devops not configured" }, 400);
    const ref = parsePrParams(c.req.param("project"), c.req.param("repo"), c.req.param("prId"));
    if ("error" in ref) return c.json({ error: ref.error }, 400);
    try {
      return c.json(await az.prDetail(ref));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // Changed-file list (no patches); diffs load per file via /file below.
  router.get("/pr/:project/:repo/:prId/files", async (c) => {
    const az = client();
    if (!az) return c.json({ error: "azure devops not configured" }, 400);
    const ref = parsePrParams(c.req.param("project"), c.req.param("repo"), c.req.param("prId"));
    if ("error" in ref) return c.json({ error: ref.error }, 400);
    try {
      return c.json(await az.prFiles(ref));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // One file's computed unified diff (lazy — fetched when its diff is opened).
  router.get("/pr/:project/:repo/:prId/file", async (c) => {
    const az = client();
    if (!az) return c.json({ error: "azure devops not configured" }, 400);
    const ref = parsePrParams(c.req.param("project"), c.req.param("repo"), c.req.param("prId"));
    if ("error" in ref) return c.json({ error: ref.error }, 400);
    const path = filePath.safeParse(c.req.query("path"));
    if (!path.success) return c.json({ error: path.error.flatten() }, 400);
    try {
      return c.json(await az.prFileDiff(ref, path.data));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  router.post("/pr/:project/:repo/:prId/comments", async (c) => {
    const az = client();
    if (!az) return c.json({ error: "azure devops not configured" }, 400);
    const ref = parsePrParams(c.req.param("project"), c.req.param("repo"), c.req.param("prId"));
    if ("error" in ref) return c.json({ error: ref.error }, 400);
    const parsed = commentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      await az.postComment(ref, parsed.data);
      return c.json({ ok: true }, 201);
    } catch (e) {
      return c.json({ error: String(e) }, 502);
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
