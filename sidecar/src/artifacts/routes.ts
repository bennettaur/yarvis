import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import {
  ARTIFACT_LIST_LIMIT,
  deleteArtifact,
  deleteArtifacts,
  getArtifact,
  listArtifacts,
} from "./service.ts";

/** Matched by shape, the same check `todos/routes.ts` applies. */
const UUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

/** The tab can only select what one listing shows, so a bulk delete never needs more. */
const bulkDeleteSchema = z.object({
  ids: z.array(z.string().regex(UUID)).min(1).max(ARTIFACT_LIST_LIMIT),
});

/**
 * Routes for the assistant's artifacts, mounted under /api/artifacts. The UI
 * reads them so the user can see what the assistant wrote, and delete what
 * they don't want kept; the agent writes them through its tools.
 */
export function createArtifactRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) => c.json(await listArtifacts(db())));

  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "not found" }, 404);
    const artifact = await getArtifact(db(), id);
    if (!artifact) return c.json({ error: "not found" }, 404);
    return c.json(artifact);
  });

  // A POST rather than a DELETE with a body, which some clients and proxies drop.
  router.post("/delete", async (c) => {
    const parsed = bulkDeleteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json({ deleted: await deleteArtifacts(db(), parsed.data.ids) });
  });

  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ deleted: false });
    return c.json({ deleted: await deleteArtifact(db(), id) });
  });

  return router;
}
