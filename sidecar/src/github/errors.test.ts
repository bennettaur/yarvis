import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { GitHubClient } from "./client.ts";
import { GitHubError, githubErrorFrom } from "./errors.ts";

function respond(status: number, headers: Record<string, string> = {}, message?: string) {
  return new Response(message === undefined ? "" : JSON.stringify({ message }), {
    status,
    headers,
  });
}

describe("githubErrorFrom", () => {
  it("reads a 401 as a token GitHub no longer accepts", async () => {
    const e = await githubErrorFrom(respond(401, {}, "Bad credentials"), "/user");
    expect(e.reason).toBe("unauthorized");
    expect(e.message).toStartWith("github /user -> 401: ");
    expect(e.explanation).toContain("Sign in to GitHub again");
  });

  it("points at the SSO authorization page when an org enforces SAML", async () => {
    const e = await githubErrorFrom(
      respond(403, { "X-GitHub-SSO": "required; url=https://github.com/orgs/acme/sso?x=1" }),
      "/repos/acme/app/issues",
    );
    expect(e.reason).toBe("sso_required");
    expect(e.explanation).toContain("https://github.com/orgs/acme/sso?x=1");
  });

  it("names the permission a fine-grained token is missing", async () => {
    const e = await githubErrorFrom(
      respond(403, { "X-Accepted-GitHub-Permissions": "issues=read" }),
      "/repos/o/r/issues",
    );
    expect(e.reason).toBe("missing_permission");
    expect(e.explanation).toContain("issues=read");
  });

  it("names the scope a classic token is missing", async () => {
    const e = await githubErrorFrom(
      respond(403, { "X-Accepted-OAuth-Scopes": "repo", "X-OAuth-Scopes": "read:org" }),
      "/repos/o/r/issues",
    );
    expect(e.reason).toBe("missing_permission");
    expect(e.explanation).toContain("needs one of: repo; has: read:org");
  });

  it("doesn't blame the scopes when the token has one GitHub accepts", async () => {
    const e = await githubErrorFrom(
      respond(
        403,
        { "X-Accepted-OAuth-Scopes": "repo, public_repo", "X-OAuth-Scopes": "repo, read:org" },
        "Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions",
      ),
      "/repos/acme/app/issues",
    );
    expect(e.reason).toBe("forbidden");
    expect(e.explanation).toContain("OAuth App access restrictions");
  });

  it("tells a primary rate limit apart from a permission problem", async () => {
    const e = await githubErrorFrom(
      respond(403, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1900000000" }),
      "/user",
    );
    expect(e.reason).toBe("rate_limited");
    expect(e.explanation).toContain("resets at");
  });

  it("reads Retry-After on a secondary rate limit", async () => {
    const e = await githubErrorFrom(respond(403, { "Retry-After": "30" }), "/user");
    expect(e.reason).toBe("rate_limited");
    expect(e.explanation).toContain("30 seconds");
  });

  it("reads a secondary limit that only the message names", async () => {
    const e = await githubErrorFrom(
      respond(403, {}, "You have exceeded a secondary rate limit."),
      "/user",
    );
    expect(e.reason).toBe("rate_limited");
  });

  it("drops an HTML error page rather than showing it", async () => {
    const e = await githubErrorFrom(
      new Response("<html><body>Bad gateway</body></html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
      "/user",
    );
    expect(e.explanation).toBe("GitHub returned an error.");
  });

  it("explains that a 404 can be a private repo the token can't see", async () => {
    const e = await githubErrorFrom(respond(404, {}, "Not Found"), "/repos/o/r/issues");
    expect(e.reason).toBe("not_found");
    expect(e.explanation).toContain("private repository");
  });
});

describe("GitHubClient rate limiting", () => {
  afterEach(() => {
    setSystemTime();
  });

  /** A GitHub that answers each call with the next status in `statuses`, 200 after that. */
  function scripted(
    statuses: { status: number; headers?: Record<string, string>; message?: string }[],
  ) {
    let calls = 0;
    const fetchImpl = (async () => {
      const next = statuses[calls++];
      return next
        ? respond(next.status, next.headers, next.message)
        : new Response(JSON.stringify({ login: "me" }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }

  it("calls GitHub again once the wait has passed", async () => {
    setSystemTime(new Date("2026-10-18T12:00:00Z"));
    const github = scripted([{ status: 429, headers: { "Retry-After": "30" } }]);
    const gh = new GitHubClient("recovering-token", github.fetchImpl);
    await expect(gh.viewer()).rejects.toBeInstanceOf(GitHubError);
    setSystemTime(new Date("2026-10-18T12:00:31Z"));
    expect(await gh.viewer()).toEqual({ login: "me" });
    expect(github.calls()).toBe(2);
  });

  it("doesn't hold back after a 403 that isn't a rate limit", async () => {
    const github = scripted([{ status: 403, headers: { "X-GitHub-SSO": "required; url=x" } }]);
    const gh = new GitHubClient("sso-token", github.fetchImpl);
    await expect(gh.viewer()).rejects.toBeInstanceOf(GitHubError);
    expect(await gh.viewer()).toEqual({ login: "me" });
  });

  it("backs off a secondary limit that only the message names", async () => {
    const github = scripted([{ status: 403, message: "You have exceeded a secondary rate limit" }]);
    const gh = new GitHubClient("secondary-token", github.fetchImpl);
    await expect(gh.viewer()).rejects.toBeInstanceOf(GitHubError);
    await expect(gh.viewer()).rejects.toBeInstanceOf(GitHubError);
    expect(github.calls()).toBe(1);
  });

  it("limits each token on its own", async () => {
    const limited = scripted([{ status: 429 }]);
    await expect(new GitHubClient("token-a", limited.fetchImpl).viewer()).rejects.toThrow();
    const other = scripted([]);
    expect(await new GitHubClient("token-b", other.fetchImpl).viewer()).toEqual({ login: "me" });
  });

  it("stops calling GitHub until the time it gave", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return respond(429, { "Retry-After": "60" });
    }) as unknown as typeof fetch;
    const gh = new GitHubClient("rate-limited-token", fetchImpl);

    await expect(gh.viewer()).rejects.toBeInstanceOf(GitHubError);
    const second = await gh.viewer().catch((e) => e);
    expect(second).toBeInstanceOf(GitHubError);
    expect((second as GitHubError).reason).toBe("rate_limited");
    expect(calls).toBe(1);
  });

  it("keeps the search limit apart from the rest of the API", async () => {
    const paths: string[] = [];
    const fetchImpl = (async (url: string) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path.startsWith("/search/")) return respond(403, { "X-RateLimit-Remaining": "0" });
      return new Response(JSON.stringify({ login: "me" }), { status: 200 });
    }) as unknown as typeof fetch;
    const gh = new GitHubClient("search-limited-token", fetchImpl);

    await expect(gh.searchIssues("is:open")).rejects.toBeInstanceOf(GitHubError);
    expect(await gh.viewer()).toEqual({ login: "me" });
    expect(paths).toEqual(["/search/issues", "/user"]);
  });
});
