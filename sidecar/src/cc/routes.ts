import { Hono } from "hono";
import {
  getPlan,
  getTranscript,
  listPlans,
  listProjects,
  listSessions,
  recentHistory,
} from "./sessions.ts";

/**
 * Claude Code introspection routes, mounted under /api/cc. Read-only access to
 * the local ~/.claude data (sessions, plans, history). No database required.
 */
export function createCcRoutes(): Hono {
  const router = new Hono();

  router.get("/projects", async (c) => c.json(await listProjects()));

  router.get("/projects/:dir/sessions", async (c) => {
    try {
      return c.json(await listSessions(c.req.param("dir")));
    } catch {
      return c.json({ error: "invalid project" }, 400);
    }
  });

  router.get("/projects/:dir/sessions/:id", async (c) => {
    try {
      return c.json(await getTranscript(c.req.param("dir"), c.req.param("id")));
    } catch {
      return c.json({ error: "invalid session" }, 400);
    }
  });

  router.get("/plans", async (c) => c.json(await listPlans()));

  router.get("/plans/:name", async (c) => {
    try {
      const name = c.req.param("name");
      return c.json({ name, content: await getPlan(name) });
    } catch {
      return c.json({ error: "invalid plan" }, 400);
    }
  });

  router.get("/history", async (c) => {
    const limit = Number(c.req.query("limit") ?? "50");
    const project = c.req.query("project");
    return c.json(await recentHistory(Number.isFinite(limit) ? limit : 50, project));
  });

  return router;
}
