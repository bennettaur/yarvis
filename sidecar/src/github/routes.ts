import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { emitEvent } from "../events/service.ts";
import { retireGuide } from "../pr/guides.ts";
import { refKey } from "../pr/types.ts";
import { GitHubClient } from "./client.ts";
import { getGithubPrConfig, saveGithubPrConfig } from "./config.ts";
import { getReviewingList } from "./reviewing.ts";
import {
  addStar,
  createFilter,
  deleteFilter,
  listFilters,
  listStars,
  removeStar,
} from "./service.ts";

/**
 * Which event a submitted review is: an approval and a change request are the
 * outcomes the weekly review-cadence read counts, so they are distinct types
 * rather than one `pr.review_submitted` carrying the verdict in its payload.
 */
const REVIEW_EVENT_BY_VERDICT = {
  APPROVE: "pr.approved",
  REQUEST_CHANGES: "pr.changes_requested",
  COMMENT: "pr.review_commented",
} as const;

/**
 * GitHub allows letters, numbers, hyphens, underscores, and dots in owner/repo
 * names, and caps at 39 chars (owner) / 100 chars (repo). Validating these
 * before they're interpolated into `${owner}/${repo}/...` API paths blocks
 * smuggling extra path segments or query strings via route params.
 */
const ownerName = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "invalid github owner");
const repoName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "invalid github repo");

const ownerRepoParams = z.object({
  owner: ownerName,
  repo: repoName,
});

const filterSchema = z.object({
  name: z.string().min(1),
  query: z.string().min(1),
});

const starSchema = z.object({
  owner: ownerName,
  repo: repoName,
  number: z.number().int(),
  title: z.string().nullish(),
  url: z.string().nullish(),
});

const commentSchema = z.object({
  path: z.string().min(1).max(1024),
  line: z.number().int().min(1),
  body: z.string().min(1),
  side: z.enum(["RIGHT", "LEFT"]).optional(),
});

const reviewSchema = z.object({
  event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
  body: z.string().max(65_536).optional(),
});

/**
 * Query for the file-content route. The commit is pinned to a full sha rather
 * than accepting any git ref: the caller always has one to hand (it comes off
 * the PR detail it already loaded), and refusing everything else keeps a branch
 * name from smuggling extra path segments into the upstream URL.
 */
const contentQuery = z.object({
  // Rejecting `..` matters here for the same reason it does in the Azure
  // schema: `encodeURIComponent` leaves `.` alone, so a traversal survives
  // encoding and `fetch` resolves it against the upstream URL before sending.
  path: z
    .string()
    .min(1)
    .max(1024)
    .refine((s) => !s.split("/").some((part) => part === "." || part === ".."), "invalid path"),
  ref: z.string().regex(/^[0-9a-f]{40}$/, "expected a commit sha"),
});

const viewedSchema = z.object({
  path: z.string().min(1).max(1024),
  viewed: z.boolean(),
});

// The merge / auto-merge body carries the chosen strategy. GitHub defaults to a
// merge commit when omitted, so `method` is optional.
const mergeSchema = z.object({
  method: z.enum(["MERGE", "SQUASH", "REBASE"]).optional(),
});

/**
 * The dashboard config. `reviewQuery` is passed to GitHub's search verbatim, so
 * it is only length-capped here — GitHub rejects malformed qualifiers itself,
 * and second-guessing its grammar would block queries that actually work. The
 * lookback is bounded because it widens both a search and a batched PR fetch.
 */
const prConfigSchema = z.object({
  reviewQuery: z.string().trim().min(1).max(512),
  reviewingLookbackDays: z.number().int().min(1).max(365),
});

/** GitHub PR dashboard routes, mounted under /api/github. */
export function createGithubRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) {
      return c.json({ error: "database not configured" }, 503);
    }
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;
  const client = () =>
    config.secrets.githubToken ? new GitHubClient(config.secrets.githubToken) : null;

  // --- Live GitHub queries (require a token) ---

  router.get("/viewer", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    try {
      return c.json(await gh.viewer());
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  router.get("/search", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const q = c.req.query("q");
    if (!q) return c.json({ error: "missing q" }, 400);
    try {
      return c.json(await gh.search(q));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // PRs the user is part-way through reviewing, split into outstanding and done.
  router.get("/reviewing", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    try {
      const [{ login }, prConfig] = await Promise.all([gh.viewer(), getGithubPrConfig()]);
      return c.json(await getReviewingList(db(), gh, login, prConfig.reviewingLookbackDays));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  function parsePrParams(
    owner: string,
    repo: string,
    rawNumber: string,
  ): { owner: string; repo: string; number: number } | { error: unknown } {
    const parsed = ownerRepoParams.safeParse({ owner, repo });
    if (!parsed.success) return { error: parsed.error.flatten() };
    const number = Number(rawNumber);
    if (!Number.isInteger(number) || number < 1) return { error: "bad number" };
    return { owner: parsed.data.owner, repo: parsed.data.repo, number };
  }

  router.get("/pr/:owner/:repo/:number", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    try {
      return c.json(await gh.prStatus(params.owner, params.repo, params.number));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // List-row summary for a single PR, so a PR named by link or by repo + number
  // can be opened without first appearing in a search result.
  router.get("/pr/:owner/:repo/:number/summary", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    try {
      return c.json(await gh.prSummary(params.owner, params.repo, params.number));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // Rich detail for the in-app review view: description, checks, review threads.
  router.get("/pr/:owner/:repo/:number/detail", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    try {
      const detail = await gh.prDetail(params.owner, params.repo, params.number);
      // A pull request closed or merged on github.com is the one ending the app
      // never sees directly. Catching it here — on a load the review view makes
      // anyway — retires the guide without a poller watching for it.
      if (detail.state.toUpperCase() !== "OPEN") {
        await retireGuide(db(), { provider: "github", ...params });
      }
      return c.json(detail);
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // Changed files with unified-diff patches for the in-app review view.
  router.get("/pr/:owner/:repo/:number/files", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    try {
      return c.json(await gh.prFiles(params.owner, params.repo, params.number));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // A changed file's full text at a commit, so the review view can reveal the
  // unchanged code a patch leaves out. Mounted under the PR (whose number the
  // lookup itself doesn't need) to keep one path shape across both providers.
  router.get("/pr/:owner/:repo/:number/content", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    const query = contentQuery.safeParse({ path: c.req.query("path"), ref: c.req.query("ref") });
    if (!query.success) return c.json({ error: "invalid path or ref" }, 400);
    try {
      const content = await gh.fileContent(
        params.owner,
        params.repo,
        query.data.path,
        query.data.ref,
      );
      return c.json({ content });
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // Mark a draft PR as ready for review.
  router.post("/pr/:owner/:repo/:number/ready", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    try {
      await gh.markReady(params.owner, params.repo, params.number);
      void emitEvent(db(), {
        type: "pr.marked_ready",
        source: "github",
        payload: { ref: refKey({ provider: "github", ...params }) },
      });
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // Submit a PR review (APPROVE / REQUEST_CHANGES / COMMENT).
  router.post("/pr/:owner/:repo/:number/reviews", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    const parsed = reviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    if (parsed.data.event === "REQUEST_CHANGES" && !parsed.data.body?.trim()) {
      return c.json({ error: "request changes requires a body" }, 400);
    }
    try {
      await gh.submitReview(
        params.owner,
        params.repo,
        params.number,
        parsed.data.event,
        parsed.data.body,
      );
      // Approving or requesting changes ends the reviewer's pass over this PR,
      // so its guide has done its job. A plain comment does not — the review is
      // still open.
      if (parsed.data.event !== "COMMENT") {
        await retireGuide(db(), { provider: "github", ...params });
      }
      void emitEvent(db(), {
        type: REVIEW_EVENT_BY_VERDICT[parsed.data.event],
        source: "github",
        payload: {
          ref: refKey({ provider: "github", ...params }),
          hasBody: Boolean(parsed.data.body?.trim()),
        },
      });
      return c.json({ ok: true }, 201);
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // Merge the PR now with the given strategy (defaults to a merge commit).
  router.post("/pr/:owner/:repo/:number/merge", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    const parsed = mergeSchema.safeParse((await c.req.json().catch(() => null)) ?? {});
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      await gh.mergePullRequest(
        params.owner,
        params.repo,
        params.number,
        parsed.data.method ?? "MERGE",
      );
      await retireGuide(db(), { provider: "github", ...params });
      void emitEvent(db(), {
        type: "pr.merged",
        source: "github",
        payload: {
          ref: refKey({ provider: "github", ...params }),
          method: parsed.data.method ?? "MERGE",
        },
      });
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // Arm auto-merge so GitHub merges once branch protections pass.
  router.post("/pr/:owner/:repo/:number/auto-merge", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    const parsed = mergeSchema.safeParse((await c.req.json().catch(() => null)) ?? {});
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      await gh.enableAutoMerge(
        params.owner,
        params.repo,
        params.number,
        parsed.data.method ?? "MERGE",
      );
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // Cancel a pending auto-merge.
  router.delete("/pr/:owner/:repo/:number/auto-merge", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    try {
      await gh.disableAutoMerge(params.owner, params.repo, params.number);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // List paths the viewer has marked "viewed" on this PR.
  router.get("/pr/:owner/:repo/:number/viewed", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    try {
      return c.json(await gh.listViewedFiles(params.owner, params.repo, params.number));
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // Mark / unmark a single file as viewed on this PR.
  router.post("/pr/:owner/:repo/:number/viewed", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    const parsed = viewedSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      await gh.setFileViewed(
        params.owner,
        params.repo,
        params.number,
        parsed.data.path,
        parsed.data.viewed,
      );
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // Post a single-line review comment to the PR.
  router.post("/pr/:owner/:repo/:number/comments", async (c) => {
    const gh = client();
    if (!gh) return c.json({ error: "github token not configured" }, 400);
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    const parsed = commentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      await gh.postComment(params.owner, params.repo, params.number, parsed.data);
      void emitEvent(db(), {
        type: "pr.commented",
        source: "github",
        payload: { ref: refKey({ provider: "github", ...params }), path: parsed.data.path ?? null },
      });
      return c.json({ ok: true }, 201);
    } catch (e) {
      return c.json({ error: String(e) }, 502);
    }
  });

  // --- Dashboard config (database only) ---

  router.get("/config", async (c) => c.json(await getGithubPrConfig()));

  router.put("/config", async (c) => {
    const parsed = prConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await saveGithubPrConfig(parsed.data));
  });

  // --- Saved filters (database only) ---

  router.get("/filters", async (c) => c.json(await listFilters(db())));

  router.post("/filters", async (c) => {
    const parsed = filterSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await createFilter(db(), parsed.data.name, parsed.data.query), 201);
  });

  router.delete("/filters/:id", async (c) =>
    c.json({ deleted: await deleteFilter(db(), c.req.param("id")) }),
  );

  // --- Starred PRs (database only) ---

  router.get("/stars", async (c) => c.json(await listStars(db())));

  router.post("/stars", async (c) => {
    const parsed = starSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    await addStar(db(), parsed.data);
    return c.json({ ok: true }, 201);
  });

  router.delete("/stars/:owner/:repo/:number", async (c) => {
    const params = parsePrParams(c.req.param("owner"), c.req.param("repo"), c.req.param("number"));
    if ("error" in params) return c.json({ error: params.error }, 400);
    return c.json({
      deleted: await removeStar(db(), params.owner, params.repo, params.number),
    });
  });

  return router;
}
