/**
 * Fills the demo database with a believable week of work, through the
 * sidecar's own API so the rows are exactly what the app would have written.
 * Every name and detail here is made up.
 */

function isoDate(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export async function seed(sidecarUrl: string, sidecarToken: string): Promise<void> {
  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${sidecarUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sidecarToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`seeding ${path} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  // The sidecar registers its built-in tools at startup only on an instance
  // that runs background workers, which the demo's doesn't. Listing the tools
  // registers them, and chat can't call `create_task` and the rest without it.
  const tools = await fetch(`${sidecarUrl}/api/mcp/tools`, {
    headers: { Authorization: `Bearer ${sidecarToken}` },
  });
  if (!tools.ok) throw new Error(`registering built-in tools failed: ${tools.status}`);

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
  // The provision route streams progress; reading it to the end waits for it.
  const workspace = await post<{ id: string }>("/api/workspaces", { name: "Checkout redesign" });
  const provision = await fetch(`${sidecarUrl}/api/workspaces/${workspace.id}/provision`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sidecarToken}` },
  });
  await provision.text();

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
