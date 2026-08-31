import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { createTodo, deleteTodo, getTodo, listTodos, updateTodo } from "./service.ts";

/**
 * Matched by shape rather than with zod's `.uuid()`, which additionally enforces
 * RFC version/variant bits that Postgres itself does not — the same check
 * `attention/routes.ts` and the MCP memory tools apply.
 */
const UUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

const priority = z.enum(["urgent", "high", "medium", "low"]);
const status = z.enum(["pending", "in_progress", "blocked", "done", "wont_do"]);

const createSchema = z.object({
  title: z.string().min(1).max(500),
  details: z.string().max(4000).nullable().optional(),
  priority: priority.optional(),
  projectId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
});

const patchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  details: z.string().max(4000).nullable().optional(),
  status: status.optional(),
  priority: priority.optional(),
  projectId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  note: z.string().max(2000).optional(),
});

/**
 * Routes for the agent's own todo list, mounted under /api/todos. The UI reads
 * these so the user can see what the assistant thinks it is doing (and correct
 * it); the agent writes them through its tools.
 */
export function createTodoRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) => {
    const statusParams = c.req.queries("status") ?? [];
    const statuses: z.infer<typeof status>[] = [];
    for (const raw of statusParams) {
      const parsed = status.safeParse(raw);
      if (!parsed.success) return c.json({ error: `unknown status: ${raw}` }, 400);
      statuses.push(parsed.data);
    }
    // Validated like the bodies in this file: an unparseable id would otherwise
    // reach a uuid column and surface as a 500 rather than a bad request.
    const projectId = c.req.query("projectId");
    if (projectId !== undefined && !UUID.test(projectId)) {
      return c.json({ error: "projectId must be a uuid" }, 400);
    }
    return c.json(
      await listTodos(db(), {
        statuses: statuses.length ? statuses : undefined,
        projectId,
      }),
    );
  });

  router.post("/", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(
      await createTodo(db(), {
        ...parsed.data,
        dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : null,
      }),
      201,
    );
  });

  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "not found" }, 404);
    const todo = await getTodo(db(), id);
    if (!todo) return c.json({ error: "not found" }, 404);
    return c.json(todo);
  });

  router.patch("/:id", async (c) => {
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { dueAt, ...rest } = parsed.data;
    if (!UUID.test(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    const todo = await updateTodo(db(), c.req.param("id"), {
      ...rest,
      ...(dueAt !== undefined ? { dueAt: dueAt ? new Date(dueAt) : null } : {}),
    });
    if (!todo) return c.json({ error: "not found" }, 404);
    return c.json(todo);
  });

  router.delete("/:id", async (c) =>
    c.json({ deleted: await deleteTodo(db(), c.req.param("id")) }),
  );

  return router;
}
