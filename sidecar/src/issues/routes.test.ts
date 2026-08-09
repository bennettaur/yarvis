import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

/**
 * The guard and validation cases are rejected by the provider guard, the
 * db/token guards, or Zod *before* any GitHub or database access, so they need
 * no real services — the same approach as the PR routes test. The last two
 * blocks do need services: they stub the global fetch the GitHub client picks
 * up, and the create block also needs the test database (see `dbApp`).
 */
function appWith(overrides: {
  databaseUrl?: string;
  secrets?: Config["secrets"];
}): ReturnType<typeof createApp> {
  return createApp({
    port: 0,
    token: "test-token",
    tokenGenerated: false,
    attentionToken: "test-attention-token",
    allowedOrigins: null,
    databaseUrl: overrides.databaseUrl,
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets: overrides.secrets ?? {},
    customProviderSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  });
}

const auth = { Authorization: "Bearer test-token" };
const json = { ...auth, "Content-Type": "application/json" };
// db configured (so the db guard passes) + a token (so the token guard passes).
const configured = appWith({
  databaseUrl: "postgres://localhost/unused",
  secrets: { githubToken: "ghp_test" },
});

describe("issue routes: auth + guards", () => {
  it("requires the bearer token", async () => {
    const res = await configured.request("/api/issues/github/repos");
    expect(res.status).toBe(401);
  });

  it("404s an unsupported provider", async () => {
    const res = await configured.request("/api/issues/linear/repos", { headers: auth });
    expect(res.status).toBe(404);
  });

  it("404s a GitHub-only route for JIRA (JIRA serves these under /api/jira)", async () => {
    // JIRA is a supported provider for the DB-backed routes (stars/filters/
    // links), but the GitHub-shaped live routes stay GitHub-only.
    const res = await configured.request("/api/issues/jira/repos", { headers: auth });
    expect(res.status).toBe(404);
  });

  it("503s when no database is configured", async () => {
    const app = appWith({ secrets: { githubToken: "ghp_test" } });
    const res = await app.request("/api/issues/github/repos", { headers: auth });
    expect(res.status).toBe(503);
  });

  it("400s live queries when no GitHub token is configured", async () => {
    const app = appWith({ databaseUrl: "postgres://localhost/unused" });
    const res = await app.request("/api/issues/github/assigned", { headers: auth });
    expect(res.status).toBe(400);
  });
});

describe("issue routes: input validation", () => {
  it("400s search without a query", async () => {
    const res = await configured.request("/api/issues/github/search", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("400s a detail request with an invalid owner (path-injection guard)", async () => {
    const res = await configured.request("/api/issues/github/detail/bad..owner/repo/1", {
      headers: auth,
    });
    expect(res.status).toBe(400);
  });

  it("400s a detail request with a non-numeric issue id", async () => {
    const res = await configured.request("/api/issues/github/detail/octo/repo/abc", {
      headers: auth,
    });
    expect(res.status).toBe(400);
  });

  it("400s creating an issue without a title", async () => {
    const res = await configured.request("/api/issues/github/create/octo/repo", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ body: "no title" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s creating an issue whose title is only whitespace", async () => {
    const res = await configured.request("/api/issues/github/create/octo/repo", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("400s creating an issue in a repo whose owner is invalid", async () => {
    const res = await configured.request("/api/issues/github/create/bad..owner/repo", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s creating an issue for a non-GitHub provider", async () => {
    const res = await configured.request("/api/issues/jira/create/octo/repo", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s an update that carries no fields", async () => {
    const res = await configured.request("/api/issues/github/detail/octo/repo/1", {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("400s an update with an unknown state", async () => {
    const res = await configured.request("/api/issues/github/detail/octo/repo/1", {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ state: "merged" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s start-work on a schema failure (missing title)", async () => {
    const res = await configured.request("/api/issues/github/start-work", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ sourceKey: "octo/repo", externalId: "1" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s start-work on a non-integer issue id", async () => {
    const res = await configured.request("/api/issues/github/start-work", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ sourceKey: "octo/repo", externalId: "abc", title: "x" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("bad issue id");
  });
});

/**
 * The update route reaches GitHub but never the database, so stubbing the global
 * fetch (which `GitHubClient` picks up when the route constructs it) is enough
 * to cover the success and failure-mapping paths without a test DB.
 */
describe("issue routes: updating an issue", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const patchIssue = (body: unknown) =>
    configured.request("/api/issues/github/detail/octo/repo/1", {
      method: "PATCH",
      headers: json,
      body: JSON.stringify(body),
    });

  it("responds with detail fetched after the edit, not the caller's input", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const path = String(url).replace("https://api.github.com", "");
      calls.push(`${init?.method ?? "GET"} ${path}`);
      // The comments fetch carries a `?per_page=` query, hence includes().
      if (path.includes("/comments")) return new Response("[]", { status: 200 });
      // GitHub's stored title differs from the request body on purpose.
      return new Response(
        JSON.stringify({ number: 1, title: "As stored by GitHub", body: "b", state: "closed" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const res = await patchIssue({ title: "As sent", state: "closed" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      externalId: "1",
      title: "As stored by GitHub",
      state: "closed",
      sourceKey: "octo/repo",
    });
    expect(calls[0]).toBe("PATCH /repos/octo/repo/issues/1");
  });

  it("502s when GitHub rejects the edit", async () => {
    globalThis.fetch = (async () =>
      new Response("no write access", { status: 403 })) as unknown as typeof fetch;
    const res = await patchIssue({ state: "closed" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("403");
  });
});

/**
 * Creating an issue is scoped to the repos flagged "pull issues", so these
 * cases need the real repos table — hence the test database.
 */
describe("issue routes: creating an issue", () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
  const sql = postgres(url, { max: 1 });
  const dbApp = appWith({ databaseUrl: url, secrets: { githubToken: "ghp_test" } });
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    await sql`TRUNCATE repos RESTART IDENTITY CASCADE`;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ number: 12, title: "Fix the thing", state: "open" }), {
        status: 201,
      })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    await sql.end();
  });

  const addRepo = (owner: string, repo: string, pullIssues: boolean) =>
    sql`INSERT INTO repos (name, owner, repo, clone_url, primary_clone_path, pull_issues)
        VALUES (${repo}, ${owner}, ${repo}, ${`git@github.com:${owner}/${repo}.git`},
                ${`/tmp/${repo}`}, ${pullIssues})`;

  const createIn = (owner: string, repo: string) =>
    dbApp.request(`/api/issues/github/create/${owner}/${repo}`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "Fix the thing" }),
    });

  it("opens the issue in a repo configured to pull issues", async () => {
    await addRepo("octo", "web", true);
    const res = await createIn("octo", "web");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ externalId: "12", sourceKey: "octo/web" });
  });

  it("refuses a repo that is registered but not set to pull issues", async () => {
    await addRepo("octo", "web", false);
    const res = await createIn("octo", "web");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("not set to pull issues");
  });

  it("refuses a repo the user never registered", async () => {
    const res = await createIn("someone", "else");
    expect(res.status).toBe(400);
  });
});

/**
 * Start work stores the composed prompt on the workspace instead of returning
 * it, which is what lets an interrupted kick-off resume. Needs the real repos
 * and workspaces tables.
 */
describe("issue routes: start work stores the kick-off prompt", () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
  const sql = postgres(url, { max: 1 });
  const dbApp = appWith({ databaseUrl: url, secrets: {} });

  beforeEach(async () => {
    await sql`TRUNCATE repos, workspaces, workspace_repos, issue_links RESTART IDENTITY CASCADE`;
    await sql`INSERT INTO repos (name, owner, repo, clone_url, primary_clone_path, pull_issues)
              VALUES ('widget', 'acme', 'widget', 'git@github.com:acme/widget.git',
                      '/tmp/widget', true)`;
  });

  afterAll(async () => {
    await sql.end();
  });

  const startWork = (body: Record<string, unknown>) =>
    dbApp.request("/api/issues/github/start-work", {
      method: "POST",
      headers: json,
      body: JSON.stringify(body),
    });

  it("stores the composed prompt, not the raw body, and keeps it off the response", async () => {
    const res = await startWork({
      sourceKey: "acme/widget",
      externalId: "42",
      title: "Fix the thing",
      body: "It is broken.",
      assignSelf: false,
      applyLabel: false,
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Record<string, unknown>;
    // The prompt no longer rides back for the caller to carry around.
    expect(created).not.toHaveProperty("prompt");

    const [row] = await sql<{ pending_issue_prompt: string | null }[]>`
      SELECT pending_issue_prompt FROM workspaces WHERE id = ${created.workspaceId as string}`;
    const stored = row?.pending_issue_prompt ?? "";
    // Composed by `buildIssuePrompt` — the framing line and heading, not just
    // the body that was posted.
    expect(stored).toContain("Implement the following acme/widget issue #42.");
    expect(stored).toContain("# Fix the thing");
    expect(stored).toContain("It is broken.");
  });
});
