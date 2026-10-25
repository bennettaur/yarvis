import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { agentRunRegistry } from "../agentRuns/service.ts";
import type { Config } from "../config.ts";
import { type Db, getDb } from "../db/client.ts";
import { clientError, describeError } from "../llm/errors.ts";
import { COMMIT_SHA_PATTERN, type PrRef } from "../pr/types.ts";
import { CONTROL_CHARACTERS } from "../workspaces/files.ts";
import { isSafePathSegment } from "../workspaces/service.ts";
import { isValidSymbol } from "./definitions.ts";
import { assertSafeRepoPath, UnsafePathError } from "./git.ts";
import { mountMutationTestingRoutes } from "./mutationRoutes.ts";
import type { MutationTestingDeps } from "./mutationTesting.ts";
import { follow, type ReviewProgressEvent } from "./progress.ts";
import {
  defaultRereviewDeps,
  latestRereview,
  type RereviewDeps,
  startRereview,
} from "./rereview.ts";
import {
  markReviewPrHere,
  reviewCommitDiff,
  reviewCommits,
  reviewLastReview,
  reviewSinceReview,
  reviewSinceReviewFile,
} from "./reviewMarks.ts";
import {
  addReviewPr,
  answerReviewSetup,
  archiveReviewWorkspace,
  createReviewWorkspace,
  defaultReviewDeps,
  getReviewPr,
  getReviewWorkspace,
  listReviewWorkspaces,
  type ReviewDeps,
  ReviewWorkspaceError,
  refreshReviewPr,
  removeReviewPr,
  renameReviewWorkspace,
  resumeIfStalled,
  reviewChangedFiles,
  reviewDiff,
  reviewFile,
  reviewSetupInfo,
  reviewSymbolSearch,
  reviewTree,
  touchReviewWorkspace,
} from "./service.ts";
import {
  defaultVerificationDeps,
  latestVerification,
  startVerification,
  type VerificationDeps,
} from "./verification.ts";

/**
 * One identity segment of a PR ref. Each one becomes a folder name under the
 * review clone root and a component of `refKey` (split on `/`), so anything
 * that could climb a directory or add a segment is refused here.
 */
const refSegmentSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (s) =>
      isSafePathSegment(s) && !CONTROL_CHARACTERS.test(s) && !s.includes(":") && s.trim() === s,
    "invalid name",
  );
const githubNameSchema = refSegmentSchema.and(z.string().regex(/^[A-Za-z0-9._-]+$/));

const prNumberSchema = z.number().int().positive();

const prRefSchema: z.ZodType<PrRef> = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("github"),
    owner: githubNameSchema,
    repo: githubNameSchema,
    number: prNumberSchema,
  }),
  z.object({
    provider: z.literal("azure"),
    org: refSegmentSchema,
    project: refSegmentSchema,
    repo: refSegmentSchema,
    prId: prNumberSchema,
  }),
]);

const nameSchema = z.string().trim().min(1).max(200);
const createSchema = z.object({
  name: nameSchema,
  refs: z.array(prRefSchema).max(20).optional(),
});
const renameSchema = z.object({ name: nameSchema });
const addPrSchema = z.object({ ref: prRefSchema });
const setupSchema = z.object({
  grant: z.boolean(),
  /** The script the user was shown; required to match before anything runs. */
  script: z.string().nullable().default(null),
  /** The head commit the prompt showed; required to match before anything runs. */
  headSha: z.string().nullable().default(null),
});
const idSchema = z.string().uuid();
/** The path is checked as a repo path by the search itself; the symbol only here. */
const symbolQuerySchema = z.object({
  path: z.string().min(1).max(4096),
  symbol: z.string().refine(isValidSymbol, "symbol must be a single identifier"),
  line: z.coerce.number().int().positive().optional(),
});

export interface ReviewWorkspaceRouteOptions {
  /** Replaces the provider and git dependencies, for tests. */
  deps?: (db: Db) => ReviewDeps;
  /** Replaces the provider, settings and `claude` the verification report uses, for tests. */
  verification?: VerificationDeps;
  /** Replaces the provider, settings and `claude` the re-review summary uses, for tests. */
  rereview?: RereviewDeps;
  /** Replaces the Claude Code program and copy helpers of mutation testing, for tests. */
  mutation?: MutationTestingDeps;
}

/**
 * Review workspaces: PRs checked out locally for review, and the git reads the
 * review UI makes against them. PR metadata (description, reviewers, checks,
 * threads) stays on the provider routes; this is only what needs the checkout.
 */
export function createReviewWorkspaceRoutes(
  config: Config,
  options: ReviewWorkspaceRouteOptions = {},
): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  // Every id in a path is a uuid; checking once here keeps a malformed one a
  // 400 rather than a Postgres cast error.
  // A middleware only sees the params its own pattern names, hence one per shape.
  for (const pattern of ["/:id", "/:id/*", "/:id/prs/:prId", "/:id/prs/:prId/*"]) {
    router.use(pattern, async (c, next) => {
      if (!idSchema.safeParse(c.req.param("id")).success) {
        return c.json({ error: "invalid review workspace id" }, 400);
      }
      const prId = c.req.param("prId");
      if (prId !== undefined && !idSchema.safeParse(prId).success) {
        return c.json({ error: "invalid pull request id" }, 400);
      }
      return next();
    });
  }

  const db = () => getDb(config.databaseUrl as string).db;
  const deps = () => (options.deps ?? ((d: Db) => defaultReviewDeps(d, config)))(db());

  const fail = (c: Context, e: unknown) => {
    if (e instanceof ReviewWorkspaceError) return c.json({ error: e.message }, e.status);
    if (e instanceof UnsafePathError) return c.json({ error: e.message }, 400);
    console.error("[review-workspaces]", describeError(e));
    return c.json({ error: clientError(e) }, 500);
  };

  router.get("/", async (c) =>
    c.json(
      await listReviewWorkspaces(db(), { includeArchived: c.req.query("archived") === "true" }),
    ),
  );

  router.post("/", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json(await createReviewWorkspace(db(), config, parsed.data, deps()), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  router.get("/:id", async (c) => {
    const ws = await getReviewWorkspace(db(), c.req.param("id"));
    return ws ? c.json(ws) : c.json({ error: "not found" }, 404);
  });

  router.patch("/:id", async (c) => {
    const parsed = renameSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const ws = await renameReviewWorkspace(db(), c.req.param("id"), parsed.data.name);
    return ws ? c.json(ws) : c.json({ error: "not found" }, 404);
  });

  router.post("/:id/open", async (c) => {
    const ws = await touchReviewWorkspace(db(), c.req.param("id"));
    return ws ? c.json(ws) : c.json({ error: "not found" }, 404);
  });

  // Answers once the workspace reads `archiving`; worktrees are removed in the
  // background and the workspace reads `archived` when that is done.
  router.post("/:id/archive", async (c) => {
    try {
      return c.json(await archiveReviewWorkspace(db(), config, c.req.param("id"), deps()), 202);
    } catch (e) {
      return fail(c, e);
    }
  });

  router.post("/:id/prs", async (c) => {
    const parsed = addPrSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json(
        await addReviewPr(db(), config, c.req.param("id"), parsed.data.ref, deps()),
        201,
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  router.delete("/:id/prs/:prId", async (c) => {
    try {
      await removeReviewPr(db(), config, c.req.param("id"), c.req.param("prId"), deps());
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });

  router.post("/:id/prs/:prId/refresh", async (c) => {
    try {
      return c.json(
        await refreshReviewPr(db(), config, c.req.param("id"), c.req.param("prId"), deps()),
        202,
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  // Replays the PR's latest clone/refresh/setup run and streams the rest of it.
  // Ends at once when nothing has run since the sidecar started. A PR left
  // mid-clone by a restart is picked back up here, since opening its progress
  // is what a view does when it finds the PR not ready.
  router.get("/:id/prs/:prId/progress", async (c) => {
    let pr: Awaited<ReturnType<typeof getReviewPr>>;
    try {
      pr = await getReviewPr(db(), c.req.param("id"), c.req.param("prId"));
    } catch (e) {
      return fail(c, e);
    }
    await resumeIfStalled(db(), config, pr, deps());
    return streamSSE(c, async (stream) => {
      const gone = new AbortController();
      stream.onAbort(() => gone.abort());
      await follow(
        pr.id,
        (event: ReviewProgressEvent) => stream.writeSSE({ data: JSON.stringify(event) }),
        gone.signal,
      );
    });
  });

  router.get("/:id/prs/:prId/changed-files", async (c) => {
    try {
      return c.json(
        await reviewChangedFiles(db(), config, c.req.param("id"), c.req.param("prId"), deps()),
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  router.get("/:id/prs/:prId/tree", async (c) => {
    try {
      return c.json(await reviewTree(db(), config, c.req.param("id"), c.req.param("prId"), deps()));
    } catch (e) {
      return fail(c, e);
    }
  });

  router.get("/:id/prs/:prId/file", async (c) => {
    const path = c.req.query("path") ?? "";
    const side = c.req.query("side") ?? "head";
    if (side !== "head" && side !== "base") {
      return c.json({ error: "side must be head or base" }, 400);
    }
    try {
      return c.json(
        await reviewFile(db(), config, c.req.param("id"), c.req.param("prId"), path, side, deps()),
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  router.get("/:id/prs/:prId/diff", async (c) => {
    const path = c.req.query("path") ?? "";
    try {
      // Checked here because the lookup it guards is a match against the
      // changed-file list, where a malformed path would only read as "not
      // changed" (404) rather than as the bad request it is.
      assertSafeRepoPath(path);
      return c.json(
        await reviewDiff(db(), config, c.req.param("id"), c.req.param("prId"), path, deps()),
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  // The latest review mark (recorded here, from the classic page, or read
  // back from the provider), with its commit fetched and pinned in the clone.
  router.get("/:id/prs/:prId/last-review", async (c) => {
    try {
      return c.json(
        await reviewLastReview(db(), config, c.req.param("id"), c.req.param("prId"), deps()),
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  // "Mark reviewed here": a manual mark at the checkout's head.
  router.post("/:id/prs/:prId/review-mark", async (c) => {
    try {
      return c.json(
        await markReviewPrHere(db(), config, c.req.param("id"), c.req.param("prId"), deps()),
        201,
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  // What the PR's own change did since the last review, or since `?from=<sha>`.
  router.get("/:id/prs/:prId/since-review", async (c) => {
    const from = c.req.query("from");
    if (from !== undefined && !COMMIT_SHA_PATTERN.test(from)) {
      return c.json({ error: "from must be a full commit sha" }, 400);
    }
    try {
      return c.json(
        await reviewSinceReview(db(), config, c.req.param("id"), c.req.param("prId"), deps(), from),
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  router.get("/:id/prs/:prId/since-review/file", async (c) => {
    const from = c.req.query("from");
    const path = c.req.query("path") ?? "";
    if (from !== undefined && !COMMIT_SHA_PATTERN.test(from)) {
      return c.json({ error: "from must be a full commit sha" }, 400);
    }
    try {
      assertSafeRepoPath(path);
      return c.json(
        await reviewSinceReviewFile(
          db(),
          config,
          c.req.param("id"),
          c.req.param("prId"),
          path,
          deps(),
          from,
        ),
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  router.get("/:id/prs/:prId/commits", async (c) => {
    const from = c.req.query("from");
    if (from !== undefined && !COMMIT_SHA_PATTERN.test(from)) {
      return c.json({ error: "from must be a full commit sha" }, 400);
    }
    try {
      return c.json(
        await reviewCommits(db(), config, c.req.param("id"), c.req.param("prId"), deps(), from),
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  // One commit's own diff: its files, or with `?path=` that file's two sides.
  router.get("/:id/prs/:prId/commits/:sha/diff", async (c) => {
    const sha = c.req.param("sha");
    const path = c.req.query("path");
    if (!COMMIT_SHA_PATTERN.test(sha)) return c.json({ error: "not a commit sha" }, 400);
    try {
      if (path !== undefined) assertSafeRepoPath(path);
      return c.json(
        await reviewCommitDiff(
          db(),
          config,
          c.req.param("id"),
          c.req.param("prId"),
          sha,
          path,
          deps(),
        ),
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  // Code navigation for any language: `?path=&line=&symbol=`, where
  // `path` is the file asking and `symbol` the identifier under the cursor.
  for (const kind of ["definitions", "references"] as const) {
    router.get(`/:id/prs/:prId/${kind}`, async (c) => {
      const parsed = symbolQuerySchema.safeParse(c.req.query());
      if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
      try {
        return c.json(
          await reviewSymbolSearch(
            db(),
            config,
            c.req.param("id"),
            c.req.param("prId"),
            kind,
            parsed.data,
            deps(),
          ),
        );
      } catch (e) {
        return fail(c, e);
      }
    });
  }

  router.get("/:id/prs/:prId/setup", async (c) => {
    try {
      return c.json(await reviewSetupInfo(db(), c.req.param("id"), c.req.param("prId"), deps()));
    } catch (e) {
      return fail(c, e);
    }
  });

  // On a yes, the script's output streams on `…/progress`.
  router.post("/:id/prs/:prId/setup", async (c) => {
    const parsed = setupSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json(
        await answerReviewSetup(
          db(),
          config,
          c.req.param("id"),
          c.req.param("prId"),
          parsed.data,
          deps(),
        ),
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  // Starts the PR's verification report, or answers with the run already
  // going for it. The run is followed on `/api/agent-runs/:runId/events`.
  router.post("/:id/prs/:prId/verification", async (c) => {
    try {
      const started = await startVerification(
        db(),
        config,
        c.req.param("id"),
        c.req.param("prId"),
        deps(),
        options.verification ?? defaultVerificationDeps(config),
      );
      return c.json(started, started.existing ? 200 : 202);
    } catch (e) {
      return fail(c, e);
    }
  });

  // The PR's latest verification run (any head), and whether it was made
  // against the head the PR is at now.
  router.get("/:id/prs/:prId/verification", async (c) => {
    const registry = options.verification?.run?.registry ?? agentRunRegistry;
    try {
      return c.json(
        await latestVerification(
          db(),
          config,
          c.req.param("id"),
          c.req.param("prId"),
          deps(),
          (id) => registry.isLive(id),
        ),
      );
    } catch (e) {
      return fail(c, e);
    }
  });
  // Starts the "What's changed" re-review over what changed since the last
  // review (or `?from=<sha>`), or answers with the run already going over the
  // same range. Followed on `/api/agent-runs/:runId/events`.
  router.post("/:id/prs/:prId/rereview", async (c) => {
    const from = c.req.query("from");
    if (from !== undefined && !COMMIT_SHA_PATTERN.test(from)) {
      return c.json({ error: "from must be a full commit sha" }, 400);
    }
    try {
      const started = await startRereview(
        db(),
        config,
        c.req.param("id"),
        c.req.param("prId"),
        deps(),
        options.rereview ?? defaultRereviewDeps(config),
        from,
      );
      return c.json(started, started.existing ? 200 : 202);
    } catch (e) {
      return fail(c, e);
    }
  });

  // The PR's latest re-review and last good one, and whether each covers the
  // range from the last review (or `?from=`) to the head now.
  router.get("/:id/prs/:prId/rereview", async (c) => {
    const from = c.req.query("from");
    if (from !== undefined && !COMMIT_SHA_PATTERN.test(from)) {
      return c.json({ error: "from must be a full commit sha" }, 400);
    }
    const registry = options.rereview?.run?.registry ?? agentRunRegistry;
    try {
      return c.json(
        await latestRereview(
          db(),
          c.req.param("id"),
          c.req.param("prId"),
          deps(),
          (id) => registry.isLive(id),
          from,
        ),
      );
    } catch (e) {
      return fail(c, e);
    }
  });
  mountMutationTestingRoutes(router, { config, db, deps, fail, mutation: options.mutation });

  return router;
}
