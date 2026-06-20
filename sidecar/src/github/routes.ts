import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { GitHubClient } from "./client.ts";
import {
  addStar,
  createFilter,
  deleteFilter,
  listFilters,
  listStars,
  removeStar,
} from "./service.ts";

/**
 * GitHub allows letters, numbers, hyphens, underscores, and dots in owner/repo
 * names, and caps at 39 chars (owner) / 100 chars (repo). Validating these
 * before they're interpolated into `${owner}/${repo}/...` API paths blocks
 * smuggling extra path segments or query strings via route params.
 */
const ownerName = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "invalid github owner");
const repoName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "invalid github repo");

const ownerRepoParams = z.object({
  owner: ownerName,
  repo: repoName,
});

const filterSchema = z.object({
  name: z.string().min(1),
  query: z.string().min(1),
});

const starSchema = z.object({
  owner: ownerName,
  repo: repoName,
  number: z.number().int(),
  title: z.string().nullish(),
  url: z.string().nullish(),
});

const commentSchema = z.object({
  path: z.string().min(1).max(1024),
  line: z.number().int().min(1),
  body: z.string().min(1),
  side: z.enum(["RIGHT", "LEFT"]).optional(),
});

/** GitHub PR dashboard routes, mounted under /api/github. */
export function createGithubRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) {
      return c.json({ error: "database not configured" }, 503);
    }
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;
  const client = () =>
    config.secrets.githubToken ? new GitHubClient(config.secrets.githubToken) : null;

  // --- Live GitHub queries (require a token) ---

  router.get("/viewer", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    try {
      return c.json(await gh.viewer());
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  router.get("/search", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const q = c.req.query("q");
    if (!q) return c.json({ error: "missing q" }, 400);
    try {
      return c.json(await gh.search(q));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  function parsePrParams(
    owner: string,
    repo: string,
    rawNumber: string,
  ): { owner: string; repo: string; number: number } | { error: unknown } {
    const parsed = ownerRepoParams.safeParse({ owner, repo });
    if (!parsed.success) return { error: parsed.error.flatten() };
    const number = Number(rawNumber);
    if (!Number.isInteger(number) || number < 1) return { error: "bad number" };
    return { owner: parsed.data.owner, repo: parsed.data.repo, number };
  }

  router.get("/pr/:owner/:repo/:number", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    try {
      return c.json(await gh.prStatus(params.owner, params.repo, params.number));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // Rich detail for the in-app review view: description, checks, review threads.
  router.get("/pr/:owner/:repo/:number/detail", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    try {
      return c.json(await gh.prDetail(params.owner, params.repo, params.number));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // Changed files with unified-diff patches for the in-app review view.
  router.get("/pr/:owner/:repo/:number/files", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    try {
      return c.json(await gh.prFiles(params.owner, params.repo, params.number));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // Post a single-line review comment to the PR.
  router.post("/pr/:owner/:repo/:number/comments", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    const parsed = commentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      await gh.postComment(params.owner, params.repo, params.number, parsed.data);
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
    return c.json(await createFilter(db(), parsed.data.name, parsed.data.query), 201);
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

  router.delete("/stars/:owner/:repo/:number", async (c) => {
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    return c.json({
      deleted: await removeStar(db(), params.owner, params.repo, params.number),
    });
  });

  return router;
}
