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

const filterSchema = z.object({
  name: z.string().min(1),
  query: z.string().min(1),
});

const starSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int(),
  title: z.string().nullish(),
  url: z.string().nullish(),
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
    config.secrets.githubToken
      ? new GitHubClient(config.secrets.githubToken)
      : null;

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

  router.get("/pr/:owner/:repo/:number", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const number = Number(c.req.param("number"));
    if (!Number.isInteger(number)) return c.json({ error: "bad number" }, 400);
    try {
      return c.json(
        await gh.prStatus(c.req.param("owner"), c.req.param("repo"), number),
      );
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
    const number = Number(c.req.param("number"));
    return c.json({
      deleted: await removeStar(
        db(),
        c.req.param("owner"),
        c.req.param("repo"),
        number,
      ),
    });
  });

  return router;
}
