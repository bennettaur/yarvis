import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
  getMutationTesting,
  type MutationProgressEvent,
  type MutationTestingDeps,
  mutationRunRegistry,
  runningMutationRunId,
  startMutationTesting,
} from "./mutationTesting.ts";
import type { ReviewDeps } from "./service.ts";

const startSchema = z.object({
  /** The head commit the user was looking at; nothing starts if the PR has moved. */
  headSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  /** The user's yes to running the tests of a PR that has no setup script. */
  confirmRunTests: z.boolean().default(false),
});

/** An idle progress stream sends a ping this often; a planning run can go quiet for minutes. */
const HEARTBEAT_MS = 25_000;

/**
 * `…/prs/:prId/mutation-testing` on the review-workspace router, which has
 * already checked both ids.
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
  const registry = context.mutation?.registry ?? mutationRunRegistry;

  // The latest pass with its results so far, and whether a new one can start.
  router.get("/:id/prs/:prId/mutation-testing", async (c) => {
    try {
      return c.json(
        await getMutationTesting(db(), c.req.param("id"), c.req.param("prId"), registry),
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  // 202 with a new pass's id, or 200 with the one already running for this PR.
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

  // Streams the running pass's progress as SSE: what it has done so far, then
  // what it does next, ending with `done`. Ends at once when nothing is running
  // here; the GET above has the stored results.
  router.get("/:id/prs/:prId/mutation-testing/progress", async (c) => {
    let runId: string | null;
    try {
      runId = await runningMutationRunId(db(), c.req.param("id"), c.req.param("prId"));
    } catch (e) {
      return fail(c, e);
    }
    return streamSSE(c, async (stream) => {
      if (!runId || !registry.isLive(runId)) return;
      const write = (event: MutationProgressEvent | { type: "ping" }) =>
        stream.writeSSE({ data: JSON.stringify(event) });
      const gone = new AbortController();
      stream.onAbort(() => gone.abort());
      const heartbeat = setInterval(() => void write({ type: "ping" }), HEARTBEAT_MS);
      try {
        await registry.follow(runId, write, gone.signal);
      } finally {
        clearInterval(heartbeat);
      }
    });
  });

  // Stops the running pass. What it found so far stays on its row.
  router.post("/:id/prs/:prId/mutation-testing/cancel", async (c) => {
    try {
      const runId = await runningMutationRunId(db(), c.req.param("id"), c.req.param("prId"));
      if (runId && registry.cancel(runId)) return c.json({ cancelling: true, runId }, 202);
      const error = runId
        ? "this run is in progress in another Yarvis instance"
        : "no mutation run is in progress";
      return c.json({ error }, 409);
    } catch (e) {
      return fail(c, e);
    }
  });
}
