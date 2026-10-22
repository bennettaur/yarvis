import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Config } from "../config.ts";
import { type Db, getDb } from "../db/client.ts";
import type { PrRef } from "../pr/types.ts";
import { isSafePathSegment } from "../workspaces/service.ts";
import { assertSafeRepoPath, UnsafePathError } from "./git.ts";
import { follow, type ReviewProgressEvent } from "./progress.ts";
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
  reviewTree,
  touchReviewWorkspace,
} from "./service.ts";

/**
 * One identity segment of a PR ref. Each one becomes a folder name under the
 * review clone root and a component of `refKey` (split on `/`), so anything
 * that could climb a directory or add a segment is refused here.
 */
const segment = z
  .string()
  .min(1)
  .max(200)
  .refine(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters never name a repo.
    (s) => isSafePathSegment(s) && !/[\x00-\x1f\x7f:]/.test(s) && s.trim() === s,
    "invalid name",
  );

const prNumber = z.number().int().positive();

export const prRefSchema: z.ZodType<PrRef> = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("github"),
    owner: segment.and(z.string().regex(/^[A-Za-z0-9._-]+$/)),
    repo: segment.and(z.string().regex(/^[A-Za-z0-9._-]+$/)),
    number: prNumber,
  }),
  z.object({
    provider: z.literal("azure"),
    org: segment,
    project: segment,
    repo: segment,
    prId: prNumber,
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
  script: z.string().nullable().optional(),
});
const idSchema = z.string().uuid();

export interface ReviewWorkspaceRouteOptions {
  /** Replaces the provider and git dependencies, for tests. */
  deps?: (db: Db) => ReviewDeps;
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
    console.error("[review-workspaces]", e);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
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
      const { workspace } = await archiveReviewWorkspace(db(), config, c.req.param("id"), deps());
      return c.json(workspace, 202);
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
    resumeIfStalled(db(), config, pr, deps());
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
      assertSafeRepoPath(path);
      return c.json(
        await reviewFile(db(), config, c.req.param("id"), c.req.param("prId"), path, side, deps()),
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  router.get("/:id/prs/:prId/diff", async (c) => {
    const path = c.req.query("path") ?? "";
    const oldPath = c.req.query("oldPath") || undefined;
    try {
      assertSafeRepoPath(path);
      if (oldPath) assertSafeRepoPath(oldPath);
      const patch = await reviewDiff(
        db(),
        config,
        c.req.param("id"),
        c.req.param("prId"),
        path,
        oldPath,
        deps(),
      );
      return c.json({ path, ...(oldPath ? { oldPath } : {}), patch });
    } catch (e) {
      return fail(c, e);
    }
  });

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
          c.req.param("id"),
          c.req.param("prId"),
          { grant: parsed.data.grant, script: parsed.data.script ?? null },
          deps(),
        ),
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  return router;
}
