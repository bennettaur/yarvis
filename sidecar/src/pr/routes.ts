import { Hono } from "hono";
import { z } from "zod";
import { clearAttentionScope, createAttention } from "../attention/service.ts";
import { AzureDevOpsClient, isAllowedAzureOrgUrl, orgFromOrgUrl } from "../azure/client.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import type { AttentionNavTarget, PrGuideRow } from "../db/schema.ts";
import { emitEvent } from "../events/service.ts";
import { GitHubClient } from "../github/client.ts";
import { availableProviders, pickDefaultModel, resolveModel } from "../llm/providers.ts";
import { deleteGuide, getGuide, isStale, saveGuide, setGuideProgress } from "./guides.ts";
import { azurePrSource, githubPrSource, type PrCodeSource } from "./source.ts";
import { generateTour } from "./tour.ts";
import { type PrRef, refKey } from "./types.ts";

/**
 * Provider-neutral pull-request routes: the generated review guide and the
 * reviewer's progress through it. Unlike the `/api/github` and `/api/azure`
 * routes, one path shape serves both providers — the ref is in the body, and
 * the provider only decides which client backs the exploration.
 */

const githubRef = z.object({
  provider: z.literal("github"),
  owner: z
    .string()
    .min(1)
    .max(39)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "invalid github owner"),
  repo: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/, "invalid github repo"),
  number: z.number().int().min(1),
});

const azureRef = z.object({
  provider: z.literal("azure"),
  org: z.string().min(1).max(200),
  project: z
    .string()
    .min(1)
    .max(200)
    .refine((s) => !s.includes("/") && !s.includes("\\") && !s.includes(".."), "invalid name"),
  repo: z
    .string()
    .min(1)
    .max(200)
    .refine((s) => !s.includes("/") && !s.includes("\\") && !s.includes(".."), "invalid name"),
  prId: z.number().int().min(1),
});

const prRef = z.discriminatedUnion("provider", [githubRef, azureRef]);

const generateSchema = z.object({
  ref: prRef,
  title: z.string().max(1024).nullish(),
  url: z.string().max(2048).nullish(),
  provider: z
    .string()
    .min(1)
    .optional()
    .describe("LLM provider id; defaults to the configured one"),
  model: z.string().min(1).optional(),
});

const progressSchema = z.object({ ref: prRef, step: z.number().int().min(0) });

/** Where the attention stream should send the user for this pull request. */
function navTargetFor(ref: PrRef): AttentionNavTarget {
  return ref.provider === "github"
    ? { type: "pr", owner: ref.owner, repo: ref.repo, number: ref.number }
    : { type: "azure-pr", org: ref.org, project: ref.project, repo: ref.repo, prId: ref.prId };
}

/** The attention item for a guide is keyed per PR, so re-generating coalesces. */
const guideSessionKey = (ref: PrRef) => `pr-guide:${refKey(ref)}`;

const stepLabel = (guide: PrGuideRow) =>
  `Step ${guide.currentStep + 1} of ${guide.steps.length}` +
  (guide.steps[guide.currentStep] ? ` · ${guide.steps[guide.currentStep]!.path}` : "");

/** The shape the frontend consumes; the row's internals stay on this side. */
function toGuideResponse(guide: PrGuideRow, headSha: string) {
  return {
    headSha: guide.headSha,
    steps: guide.steps,
    currentStep: guide.currentStep,
    stale: isStale(guide, headSha),
    createdAt: guide.createdAt,
  };
}

export function createPrRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  /**
   * Builds the code source for a ref, or an error message naming what is
   * missing. The Azure organization is bound from configuration rather than
   * trusted from the request, so a ref naming a different org is refused
   * outright instead of being pointed at a host we did not configure.
   */
  const sourceFor = (ref: PrRef): PrCodeSource | { error: string } => {
    if (ref.provider === "github") {
      const token = config.secrets.githubToken;
      if (!token) return { error: "github token not configured" };
      return githubPrSource(new GitHubClient(token), ref);
    }
    const { azureDevopsToken, azureDevopsOrgUrl } = config.secrets;
    if (!azureDevopsToken || !azureDevopsOrgUrl) return { error: "azure devops not configured" };
    if (!isAllowedAzureOrgUrl(azureDevopsOrgUrl)) return { error: "invalid azure org url" };
    if (orgFromOrgUrl(azureDevopsOrgUrl) !== ref.org) {
      return { error: "pull request belongs to a different azure organization" };
    }
    return azurePrSource(new AzureDevOpsClient(azureDevopsToken, azureDevopsOrgUrl), ref);
  };

  /**
   * Keeps the attention stream in step with a guide's progress. The item
   * coalesces on (sessionKey, kind), so regenerating or advancing updates the
   * one live entry rather than stacking. Reaching the last step resolves it —
   * the review is no longer in progress, and a finished guide sitting in the
   * panel would read as outstanding work.
   */
  const syncAttention = async (ref: PrRef, guide: PrGuideRow) => {
    const sessionKey = guideSessionKey(ref);
    const finished = guide.currentStep >= guide.steps.length - 1;
    if (finished) {
      await clearAttentionScope(db(), { sessionKey }, "resolved");
      return;
    }
    await createAttention(db(), {
      source: "system",
      sessionKey,
      kind: "info",
      title: guide.title ? `Reviewing ${guide.title}` : "PR review in progress",
      body: stepLabel(guide),
      navTarget: navTargetFor(ref),
    });
  };

  // Generate (or regenerate) a guide. Replaces any existing one for the PR.
  router.post("/guide", async (c) => {
    const parsed = generateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { ref, title, url } = parsed.data;

    const source = sourceFor(ref);
    if ("error" in source) return c.json({ error: source.error }, 400);

    const dbh = db();
    const providers = await availableProviders(config, dbh);
    const fallback = pickDefaultModel(providers);
    const providerId = parsed.data.provider ?? fallback?.provider;
    const modelId = parsed.data.model ?? fallback?.model;
    if (!providerId || !modelId) {
      return c.json({ error: "no LLM provider is configured" }, 400);
    }

    let model: Awaited<ReturnType<typeof resolveModel>>;
    try {
      model = await resolveModel(config, dbh, providerId as never, modelId);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }

    try {
      const { steps, headSha } = await generateTour(model, source, c.req.raw.signal);
      const guide = await saveGuide(dbh, { ref, headSha, steps, title, url });
      await syncAttention(ref, guide);
      void emitEvent(dbh, {
        type: "pr.guide.generated",
        source: ref.provider,
        payload: { ref: refKey(ref), title, url, steps: steps.length },
      });
      return c.json(toGuideResponse(guide, headSha));
    } catch (e) {
      console.error("[pr] guide generation failed:", e);
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  // The stored guide for a PR, with whether the PR has moved past it.
  router.get("/guide", async (c) => {
    const parsed = prRef.safeParse(parseRefQuery(c.req.query()));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const ref = parsed.data;

    const guide = await getGuide(db(), ref);
    if (!guide) return c.json({ guide: null });

    // Staleness needs the PR's current head, which costs a provider call. A
    // guide that can't be checked is reported as it stands rather than failing
    // the read — the reviewer can still use it.
    let headSha = guide.headSha;
    const source = sourceFor(ref);
    if (!("error" in source)) {
      try {
        headSha = (await source.detail()).headSha;
      } catch (e) {
        console.error("[pr] could not check guide staleness:", e);
      }
    }

    void emitEvent(db(), {
      type: "pr.guide.viewed",
      source: ref.provider,
      payload: { ref: refKey(ref), title: guide.title, step: guide.currentStep },
    });
    return c.json({ guide: toGuideResponse(guide, headSha) });
  });

  // Record how far the reviewer has read.
  router.patch("/guide/progress", async (c) => {
    const parsed = progressSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { ref, step } = parsed.data;

    const guide = await setGuideProgress(db(), ref, step);
    if (!guide) return c.json({ error: "no guide for this pull request" }, 404);
    await syncAttention(ref, guide);
    return c.json({ currentStep: guide.currentStep });
  });

  router.delete("/guide", async (c) => {
    const parsed = prRef.safeParse(parseRefQuery(c.req.query()));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const deleted = await deleteGuide(db(), parsed.data);
    await clearAttentionScope(db(), { sessionKey: guideSessionKey(parsed.data) }, "resolved");
    return c.json({ deleted });
  });

  return router;
}

/**
 * Rebuilds a ref from query parameters. GET and DELETE can't carry a body, and
 * the numeric fields arrive as strings, so they are coerced before the same
 * schema that guards the POST bodies validates them.
 */
function parseRefQuery(query: Record<string, string>): unknown {
  if (query.provider === "azure") {
    return {
      provider: "azure",
      org: query.org,
      project: query.project,
      repo: query.repo,
      prId: Number(query.prId),
    };
  }
  return {
    provider: "github",
    owner: query.owner,
    repo: query.repo,
    number: Number(query.number),
  };
}
