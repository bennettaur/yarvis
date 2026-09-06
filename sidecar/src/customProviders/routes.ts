import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { UrlSafetyError, validateOutboundUrl } from "../lib/urlSafety.ts";
import {
  createCustomProvider,
  deleteCustomProvider,
  getCustomProvider,
  listCustomProviders,
  updateCustomProvider,
} from "./service.ts";

const apiKind = z.enum(["openai", "openai-chat", "anthropic"]);

/** RFC 7230 token characters, the legal set for HTTP header names. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
/**
 * Reserved header names the user must not be able to override on outbound
 * provider requests — preventing auth-bypass and request smuggling.
 */
const RESERVED_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

const headerName = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => HEADER_NAME.test(v), "header name must match RFC 7230 token charset")
  .refine(
    (v) => !RESERVED_HEADER_NAMES.has(v.toLowerCase()),
    "header name is reserved and cannot be customised",
  );

const trimmedStrings = z.array(z.string().min(1));
const headerNames = z.array(headerName);

const baseUrl = z
  .string()
  .url()
  .max(2048)
  .superRefine((value, ctx) => {
    try {
      validateOutboundUrl(value, { allowLoopback: true });
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: e instanceof UrlSafetyError ? e.message : "url is not allowed",
      });
    }
  });

const createSchema = z.object({
  name: z.string().min(1),
  baseUrl,
  apiKind,
  models: trimmedStrings.default([]),
  headerNames: headerNames.default([]),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  baseUrl: baseUrl.optional(),
  apiKind: apiKind.optional(),
  models: trimmedStrings.optional(),
  headerNames: headerNames.optional(),
});

/**
 * Custom provider CRUD, mounted under /api/custom-providers. Rows live in
 * `~/.yarvis/settings.json`, so no database handle is needed; `config` stays
 * a parameter only so callers can pass it uniformly with the other route
 * factories.
 */
export function createCustomProviderRoutes(_config: Config): Hono {
  const router = new Hono();

  router.get("/", async (c) => c.json(await listCustomProviders()));

  router.get("/:id", async (c) => {
    const row = await getCustomProvider(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  router.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await createCustomProvider(parsed.data), 201);
  });

  router.patch("/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const row = await updateCustomProvider(c.req.param("id"), parsed.data);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  router.delete("/:id", async (c) => {
    const ok = await deleteCustomProvider(c.req.param("id"));
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.body(null, 204);
  });

  return router;
}
