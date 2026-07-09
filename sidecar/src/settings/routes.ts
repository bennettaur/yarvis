import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { CLAUDE_COMMAND_KEY, getSetting, setSetting } from "./service.ts";

export function createSettingsRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) => {
    const claudeCommand = (await getSetting(db(), CLAUDE_COMMAND_KEY)) ?? "claude";
    return c.json({ claudeCommand });
  });

  router.patch("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const schema = z.object({
      claudeCommand: z.string().min(1).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    if (parsed.data.claudeCommand) {
      await setSetting(db(), CLAUDE_COMMAND_KEY, parsed.data.claudeCommand);
    }

    return c.json({ ok: true });
  });

  return router;
}
