import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import {
  addProjectItem,
  deleteProject,
  listProjects,
  projectOverview,
  removeProjectItem,
  updateProject,
  updateProjectItem,
  upsertProject,
} from "./service.ts";

const priority = z.enum(["urgent", "high", "medium", "low"]);
const status = z.enum(["active", "paused", "shipped", "abandoned"]);

const createSchema = z.object({
  name: z.string().min(1).max(120),
  summary: z.string().max(2000).nullable().optional(),
  focus: z.string().max(500).nullable().optional(),
  repoIds: z.array(z.string().uuid()).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  status: status.optional(),
  summary: z.string().max(2000).nullable().optional(),
  focus: z.string().max(500).nullable().optional(),
  repoIds: z.array(z.string().uuid()).optional(),
});

const itemSchema = z.object({
  kind: z.enum(["jira", "github", "pr", "note"]),
  externalKey: z.string().max(200).nullable().optional(),
  title: z.string().min(1).max(500),
  priority: priority.optional(),
  note: z.string().max(1000).nullable().optional(),
});

const itemPatchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  priority: priority.optional(),
  note: z.string().max(1000).nullable().optional(),
  done: z.boolean().optional(),
});

/** Project routes, mounted under /api/projects. */
export function createProjectRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) => {
    const statusParam = c.req.query("status");
    const parsed = statusParam ? status.safeParse(statusParam) : null;
    if (parsed && !parsed.success) return c.json({ error: "unknown status" }, 400);
    return c.json(await listProjects(db(), { status: parsed?.data }));
  });

  router.post("/", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { project, created } = await upsertProject(db(), {
      name: parsed.data.name,
      summary: parsed.data.summary ?? undefined,
      focus: parsed.data.focus ?? undefined,
      repoIds: parsed.data.repoIds,
    });
    return c.json(project, created ? 201 : 200);
  });

  // The project plus its items and open tasks — what the Projects tab renders.
  router.get("/:id", async (c) => {
    const overview = await projectOverview(db(), c.req.param("id"));
    if (!overview) return c.json({ error: "not found" }, 404);
    return c.json(overview);
  });

  router.patch("/:id", async (c) => {
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const project = await updateProject(db(), c.req.param("id"), parsed.data);
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json(project);
  });

  router.delete("/:id", async (c) =>
    c.json({ deleted: await deleteProject(db(), c.req.param("id")) }),
  );

  router.post("/:id/items", async (c) => {
    const parsed = itemSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const item = await addProjectItem(db(), {
      projectId: c.req.param("id"),
      kind: parsed.data.kind,
      externalKey: parsed.data.externalKey ?? null,
      title: parsed.data.title,
      priority: parsed.data.priority,
      note: parsed.data.note ?? null,
    });
    return c.json(item, 201);
  });

  router.patch("/items/:itemId", async (c) => {
    const parsed = itemPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const item = await updateProjectItem(db(), c.req.param("itemId"), parsed.data);
    if (!item) return c.json({ error: "not found" }, 404);
    return c.json(item);
  });

  router.delete("/items/:itemId", async (c) =>
    c.json({ removed: await removeProjectItem(db(), c.req.param("itemId")) }),
  );

  return router;
}
