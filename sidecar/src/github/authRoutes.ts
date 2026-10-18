import { Hono } from "hono";
import { saveGitHubToken } from "../core/controlClient.ts";
import { GitHubDeviceFlow, githubClientId } from "./deviceFlow.ts";

/**
 * GitHub sign-in. Kept apart from the `/api/github` routes because those need
 * the database and signing in must not.
 */
export function createGithubAuthRoutes(
  deviceFlow: GitHubDeviceFlow | null = defaultDeviceFlow(),
): Hono {
  const router = new Hono();

  router.post("/device", async (c) => {
    if (!deviceFlow) {
      return c.json(
        { error: "GitHub sign-in isn't set up in this build", reason: "not_configured" },
        503,
      );
    }
    try {
      return c.json(await deviceFlow.start());
    } catch (e) {
      console.error("[github] device flow start failed:", String(e));
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  router.get("/device/:id", (c) => {
    const status = deviceFlow?.status(c.req.param("id"));
    if (!status) return c.json({ error: "unknown sign-in" }, 404);
    return c.json(status);
  });

  router.delete("/device/:id", (c) => {
    deviceFlow?.cancel(c.req.param("id"));
    return c.body(null, 204);
  });

  return router;
}

function defaultDeviceFlow(): GitHubDeviceFlow | null {
  const clientId = githubClientId();
  return clientId ? new GitHubDeviceFlow({ clientId, saveToken: saveGitHubToken }) : null;
}
