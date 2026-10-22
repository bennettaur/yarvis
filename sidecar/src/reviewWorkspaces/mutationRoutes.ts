import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
  getMutationTesting,
  type MutationTestingDeps,
  startMutationTesting,
} from "./mutationTesting.ts";
import type { ReviewDeps } from "./service.ts";

const startSchema = z.object({
  /** The head commit the user was looking at; nothing starts if the PR has moved. */
  headSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  /** The user's yes to running the tests of a PR that has no setup script. */
  confirmRunTests: z.boolean().default(false),
});

/**
 * `…/prs/:prId/mutation-testing` on the review-workspace router, which has
 * already checked both ids. The run itself is followed and cancelled through
 * `/api/agent-runs/:runId`.
 */
export function mountMutationTestingRoutes(
  router: Hono,
  context: {
    config: Config;
    db: () => Db;
    deps: () => ReviewDeps;
    fail: (c: Context, e: unknown) => Response | Promise<Response>;
    mutation?: MutationTestingDeps;
  },
): void {
  const { config, db, deps, fail } = context;

  router.get("/:id/prs/:prId/mutation-testing", async (c) => {
    try {
      return c.json(await getMutationTesting(db(), c.req.param("id"), c.req.param("prId")));
    } catch (e) {
      return fail(c, e);
    }
  });

  // 202 with a new run's id, or 200 with the one already running for this PR.
  router.post("/:id/prs/:prId/mutation-testing", async (c) => {
    const parsed = startSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      const started = await startMutationTesting(
        db(),
        config,
        c.req.param("id"),
        c.req.param("prId"),
        parsed.data,
        deps(),
        context.mutation,
      );
      return c.json(started, started.existing ? 200 : 202);
    } catch (e) {
      return fail(c, e);
    }
  });
}
