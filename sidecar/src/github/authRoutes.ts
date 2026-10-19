import { Hono } from "hono";
import type { Config } from "../config.ts";
import { saveGitHubToken } from "../core/controlClient.ts";
import { createGitHubClient } from "./client.ts";
import { GitHubDeviceFlow, githubClientId } from "./deviceFlow.ts";

/**
 * GitHub sign-in. Kept apart from the `/api/github` routes because those need
 * the database and signing in must not.
 */
export function createGithubAuthRoutes(
  config: Pick<Config, "endpoints">,
  deviceFlow: GitHubDeviceFlow | null = defaultDeviceFlow(config),
): Hono {
  const router = new Hono();

  // Lets Settings hide the button in a build with no OAuth App client ID.
  router.get("/", (c) => c.json({ configured: deviceFlow !== null }));

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

function defaultDeviceFlow(config: Pick<Config, "endpoints">): GitHubDeviceFlow | null {
  // A github.com token would be sent to whatever stands in for the API.
  if (config.endpoints?.githubApi || config.endpoints?.githubGraphql) return null;
  const clientId = githubClientId();
  if (!clientId) return null;
  return new GitHubDeviceFlow({
    clientId,
    saveToken: saveGitHubToken,
    lookupLogin: async (token) => (await createGitHubClient(config, token).viewer()).login,
  });
}
