import { Hono } from "hono";
import type { Config } from "../config.ts";
import { catalog, reloadCatalog } from "./catalog.ts";

/**
 * Specialist routes, mounted under /api/specialists.
 *
 * Read-only, because the files are the source of truth: a definition is a
 * markdown file the user edits in `~/.yarvis/agents`, or one this repo ships. An
 * edit endpoint would have to write those files and would then be a second way to
 * say the same thing — so the panel lists what is loaded, names the directory,
 * surfaces any file that failed to parse, and offers a reload.
 */
export function createSpecialistRoutes(_config: Config): Hono {
  const router = new Hono();

  router.get("/", async (c) => {
    const { specialists, problems, userDir } = await catalog();
    return c.json({ specialists, problems, userDir });
  });

  // Picks up a file the user just added or edited, without restarting the app.
  router.post("/reload", async (c) => {
    const { specialists, problems, userDir } = await reloadCatalog();
    return c.json({ specialists, problems, userDir });
  });

  return router;
}
