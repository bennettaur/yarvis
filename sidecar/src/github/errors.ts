import type { Context } from "hono";

/** Why GitHub refused a request, as far as its response says. */
export type GitHubFailureReason =
  | "unauthorized"
  | "sso_required"
  | "missing_permission"
  | "forbidden"
  | "rate_limited"
  | "not_found"
  | "upstream_error";

const SIGN_IN_AGAIN = "Sign in to GitHub again in Settings → Credentials.";

/**
 * A failed GitHub call, with the reason read from GitHub's response headers.
 * The message keeps the `github <request> -> <status>` prefix callers and logs
 * already match on, followed by an explanation a user can act on.
 */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly reason: GitHubFailureReason,
    readonly explanation: string,
    request: string,
  ) {
    super(`github ${request} -> ${status}: ${explanation}`);
    this.name = "GitHubError";
  }
}

/**
 * Builds a {@link GitHubError} from a non-ok response. GitHub explains most
 * refusals in headers rather than the status: a 403 can be SSO, a missing
 * permission, an org blocking the app, or a rate limit.
 * https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api
 */
export async function githubErrorFrom(res: Response, request: string): Promise<GitHubError> {
  const message = await readGitHubMessage(res);
  const { reason, explanation } = classify(res.status, res.headers, message);
  return new GitHubError(res.status, reason, explanation, request);
}

/** A proxy error or outage page can be a whole HTML document, so plain text is cut short. */
const MAX_PLAIN_MESSAGE_LENGTH = 200;

async function readGitHubMessage(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { message?: unknown };
      return typeof body.message === "string" ? body.message : null;
    } catch {
      if (/html/i.test(res.headers.get("content-type") ?? "")) return null;
      return text.trim().slice(0, MAX_PLAIN_MESSAGE_LENGTH) || null;
    }
  } catch {
    return null;
  }
}

/** Used when GitHub signals a rate limit but gives no time to wait. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * How long GitHub asked us to wait, or null when the response isn't a rate
 * limit. A primary limit has no requests left; a secondary limit sends
 * Retry-After, or says so only in the message.
 * https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit
 */
export function rateLimitWaitMs(
  status: number,
  headers: Headers,
  message: string | null,
): number | null {
  if (status !== 403 && status !== 429) return null;
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    return Number.isFinite(reset) && reset > 0
      ? Math.max(reset * 1000 - Date.now(), 0)
      : DEFAULT_RATE_LIMIT_WAIT_MS;
  }
  if (status === 429 || /rate limit/i.test(message ?? "")) return DEFAULT_RATE_LIMIT_WAIT_MS;
  return null;
}

function classify(
  status: number,
  headers: Headers,
  message: string | null,
): { reason: GitHubFailureReason; explanation: string } {
  if (status === 401) {
    return {
      reason: "unauthorized",
      explanation: `GitHub rejected the token. It has expired or been revoked. ${SIGN_IN_AGAIN}`,
    };
  }

  const waitMs = rateLimitWaitMs(status, headers, message);
  if (waitMs !== null) {
    return { reason: "rate_limited", explanation: rateLimitExplanation(headers, waitMs) };
  }

  if (status === 403) {
    const sso = headers.get("x-github-sso");
    if (sso) {
      const url = /url=(\S+)/.exec(sso)?.[1];
      return {
        reason: "sso_required",
        explanation: url
          ? `This organization requires SAML SSO, and the token isn't authorized for it. Authorize it at ${url}`
          : "This organization requires SAML SSO, and the token isn't authorized for it. Authorize it for the organization on GitHub.",
      };
    }

    // Fine-grained tokens and GitHub Apps name the permission they lacked.
    const permissions = headers.get("x-accepted-github-permissions");
    if (permissions) {
      return {
        reason: "missing_permission",
        explanation: `The token is missing a permission this needs (GitHub accepts: ${permissions}).`,
      };
    }

    // Classic tokens and OAuth apps name the scopes instead.
    const accepted = headers.get("x-accepted-oauth-scopes");
    const granted = headers.get("x-oauth-scopes");
    if (accepted && granted !== null && !hasAnyScope(granted, accepted)) {
      return {
        reason: "missing_permission",
        explanation: `The token is missing a scope this needs (needs one of: ${accepted}; has: ${granted || "none"}). ${SIGN_IN_AGAIN}`,
      };
    }

    // An org that restricts OAuth app access, a repo that's archived, and
    // similar refusals carry no header, only GitHub's own message.
    return {
      reason: "forbidden",
      explanation: message
        ? `GitHub refused the request: ${message}`
        : "GitHub refused the request.",
    };
  }

  if (status === 404) {
    return {
      reason: "not_found",
      explanation:
        "Not found. GitHub also answers 404 for a private repository the token can't see, so check the token has access to it.",
    };
  }

  return {
    reason: "upstream_error",
    explanation: message ? `GitHub returned an error: ${message}` : "GitHub returned an error.",
  };
}

function rateLimitExplanation(headers: Headers, waitMs: number): string {
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (!headers.has("retry-after") && Number.isFinite(reset) && reset > 0) {
    const at = new Date(reset * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `GitHub's rate limit was hit. It resets at ${at}.`;
  }
  return `GitHub's rate limit was hit. Try again in ${Math.ceil(waitMs / 1000)} seconds.`;
}

function hasAnyScope(granted: string, accepted: string): boolean {
  const have = new Set(granted.split(",").map((s) => s.trim()));
  return accepted
    .split(",")
    .map((s) => s.trim())
    .some((scope) => have.has(scope));
}

const STATUS_BY_REASON: Record<GitHubFailureReason, 401 | 403 | 404 | 429 | 502> = {
  unauthorized: 401,
  sso_required: 403,
  missing_permission: 403,
  forbidden: 403,
  rate_limited: 429,
  not_found: 404,
  upstream_error: 502,
};

/**
 * Logs a failed GitHub route in full and answers with GitHub's reason. A
 * failure that isn't a {@link GitHubError} (a network error, a bug) stays a 502.
 */
export function githubErrorResponse(c: Context, e: unknown): Response {
  console.error(`[github] ${c.req.method} ${c.req.path} failed:`, String(e));
  if (e instanceof GitHubError) {
    return c.json({ error: e.explanation, reason: e.reason }, STATUS_BY_REASON[e.reason]);
  }
  return c.json({ error: String(e), reason: "upstream_error" }, 502);
}

/** The answer every GitHub route gives when no token is saved. */
export function missingTokenResponse(c: Context): Response {
  return c.json({ error: "github token not configured", reason: "missing_token" }, 400);
}

/** One entry of a GraphQL reply's `errors` array. */
export interface GraphqlErrorEntry {
  type?: string;
  path?: (string | number)[];
  message?: string;
}

/**
 * Builds a {@link GitHubError} from a GraphQL reply that carries errors. GraphQL
 * answers most refusals with a 200 and names the reason in each error's `type`,
 * where REST would use the status and headers.
 */
export function githubErrorFromGraphql(errors: GraphqlErrorEntry[]): GitHubError {
  const detail =
    errors
      .map((e) => e.message)
      .filter(Boolean)
      .join("; ") || JSON.stringify(errors);
  const has = (type: string) => errors.some((e) => e.type === type);
  if (has("RATE_LIMITED")) {
    return new GitHubError(429, "rate_limited", "GitHub's GraphQL rate limit was hit.", "graphql");
  }
  if (errors.some((e) => /SAML/i.test(e.message ?? ""))) {
    return new GitHubError(
      403,
      "sso_required",
      `This organization requires SAML SSO, and the token isn't authorized for it. ${detail}`,
      "graphql",
    );
  }
  if (has("FORBIDDEN")) {
    return new GitHubError(403, "forbidden", `GitHub refused the request: ${detail}`, "graphql");
  }
  if (has("NOT_FOUND")) {
    return new GitHubError(
      404,
      "not_found",
      `Not found (${detail}). GitHub also answers this for a private repository the token can't see, so check the token has access to it.`,
      "graphql",
    );
  }
  return new GitHubError(502, "upstream_error", `GitHub returned an error: ${detail}`, "graphql");
}

/**
 * Whether a read that failed through GraphQL should be retried through REST.
 * Only when GraphQL couldn't answer at all: its rate limit is spent, GitHub is
 * failing, or the network is. A refusal (no access, SSO, not found) would be
 * the answer either way, so it is reported, not retried. An error type this
 * doesn't recognise, such as a query a GitHub Enterprise server can't run,
 * falls back too, since REST may still answer it.
 */
export function shouldFallBackToRest(e: unknown): boolean {
  return e instanceof GitHubError && (e.reason === "rate_limited" || e.reason === "upstream_error");
}
