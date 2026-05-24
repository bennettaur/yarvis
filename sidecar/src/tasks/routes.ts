import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import {
  completeTask,
  createTask,
  listTasks,
  rolloverTasks,
  updateTask,
} from "./service.ts";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const createSchema = z.object({
  title: z.string().min(1),
  scope: z.enum(["daily", "weekly"]),
  targetDate: isoDate.nullish(),
  notes: z.string().nullish(),
  sourceSessionId: z.string().uuid().nullish(),
});

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  scope: z.enum(["daily", "weekly"]).optional(),
  status: z.enum(["open", "done"]).optional(),
  targetDate: isoDate.nullish(),
  notes: z.string().nullish(),
});

const rolloverSchema = z.object({ fromDate: isoDate, toDate: isoDate });

const listSchema = z.object({
  status: z.enum(["open", "done"]).optional(),
  scope: z.enum(["daily", "weekly"]).optional(),
  targetDate: isoDate.optional(),
});

/** Task CRUD + rollover routes, mounted under /api/tasks. */
export function createTaskRoutes(config: Config): Hono {
  const router = new Hono();

  // Every task route needs a configured database.
  router.use("*", async (c, next) => {
    if (!config.databaseUrl) {
      return c.json({ error: "database not configured" }, 503);
    }
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) => {
    const parsed = listSchema.safeParse({
      status: c.req.query("status"),
      scope: c.req.query("scope"),
      targetDate: c.req.query("targetDate"),
    });
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await listTasks(db(), parsed.data));
  });

  router.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await createTask(db(), parsed.data), 201);
  });

  router.post("/rollover", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = rolloverSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const moved = await rolloverTasks(db(), parsed.data.fromDate, parsed.data.toDate);
    return c.json({ moved: moved.length, tasks: moved });
  });

  router.post("/:id/complete", async (c) => {
    const task = await completeTask(db(), c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json(task);
  });

  router.patch("/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const task = await updateTask(db(), c.req.param("id"), parsed.data);
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json(task);
  });

  return router;
}
