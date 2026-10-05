/**
 * Fills the demo database with a believable week of work. Rows go through the
 * sidecar's own API wherever it has a route, so they're exactly what the app
 * would have written. Every name and detail here is made up.
 */

import { spawnSync } from "node:child_process";
import { OWNER as GITHUB_OWNER, REPO as GITHUB_REPO } from "./fakeGithub/data";

function isoDate(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/**
 * Marks Google Calendar as connected. There's no route for it (the token
 * normally arrives through the OAuth callback), so the row goes straight into
 * the table, whose columns are `googleTokens` in `sidecar/src/db/schema.ts`.
 * The scope is `CALENDAR_SCOPE` from `sidecar/src/google/client.ts`. It doesn't
 * expire during a run, so nothing tries to refresh it.
 */
function connectGoogle(databaseUrl: string): void {
  const sql = `INSERT INTO google_tokens (access_token, refresh_token, scope, expires_at)
    VALUES ('demo-google-access-token', 'demo-google-refresh-token',
      'https://www.googleapis.com/auth/calendar.events', now() + interval '30 days')`;
  const result = spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-qc", sql], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`connecting Google failed: ${result.stderr}`);
}

export async function seed({
  sidecarUrl,
  sidecarToken,
  databaseUrl,
}: {
  sidecarUrl: string;
  sidecarToken: string;
  databaseUrl: string;
}): Promise<void> {
  async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${sidecarUrl}${path}`, {
      headers: { Authorization: `Bearer ${sidecarToken}` },
    });
    if (!res.ok) throw new Error(`reading ${path} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${sidecarUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sidecarToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`seeding ${path} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  connectGoogle(databaseUrl);
  // The Issues tab lists issues from repos that opt in. Registering one clones
  // nothing; only a workspace that uses it would.
  await post("/api/repos", {
    cloneUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`,
    pullIssues: true,
  });

  const project = await post<{ id: string }>("/api/projects", {
    name: "Checkout redesign",
    summary: "Rebuild the checkout flow so it loads in under a second on mobile.",
    focus: "Ship the new payment step behind a flag",
  });

  for (const todo of [
    { title: "Review Priya's payment-step PR", priority: "high", dueAt: inDays(1) },
    { title: "Write the rollout plan for the checkout flag", priority: "medium", dueAt: inDays(3) },
    { title: "Fix flaky cart totals test", priority: "low" },
  ]) {
    await post("/api/todos", { ...todo, projectId: project.id });
  }
  await post("/api/todos", { title: "Book flights for the offsite", priority: "medium" });

  for (const task of [
    { title: "Prep demo for Thursday's review", scope: "daily", targetDate: isoDate() },
    { title: "Reply to the design feedback thread", scope: "daily", targetDate: isoDate() },
    { title: "Get the payment step to code complete", scope: "weekly" },
  ]) {
    await post("/api/tasks", task);
  }

  // A scratch workspace (no repos), so provisioning needs no git or network.
  // The provision route streams progress and reports a failure as an event in
  // that stream, so reading it to the end waits for it and the status is
  // checked afterwards.
  const workspace = await post<{ id: string }>("/api/workspaces", { name: "Payment step" });
  const provisionResponse = await fetch(`${sidecarUrl}/api/workspaces/${workspace.id}/provision`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sidecarToken}` },
  });
  await provisionResponse.text();
  const provisioned = await get<{ status: string }>(`/api/workspaces/${workspace.id}`);
  if (provisioned.status !== "active") {
    throw new Error(`provisioning the demo workspace left it "${provisioned.status}"`);
  }

  for (const memory of [
    { kind: "preference", content: "Prefers morning focus blocks with no meetings before 11am." },
    { kind: "fact", content: "Priya Shah leads the payments team and reviews checkout changes." },
    {
      kind: "fact",
      content: "The checkout redesign targets a sub-second load on mid-range phones.",
    },
    {
      kind: "note",
      content: "Thursday's review: show the new payment step and the load-time chart.",
    },
  ]) {
    await post("/api/memory", memory);
  }
}
