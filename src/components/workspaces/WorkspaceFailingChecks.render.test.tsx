import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { prDetailKey } from "../../lib/pr/cache";
import type { CheckItem, PrDetail, PrRef } from "../../lib/pr/types";
import { invalidate, primeCache } from "../../lib/resourceCache";
import { mountForInteraction, waitFor } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";
import WorkspaceFailingChecks from "./WorkspaceFailingChecks";

interface SentRequest {
  path: string;
  body: Record<string, unknown> | null;
}

const sent: SentRequest[] = [];
let replies: { status: number; body: unknown }[] = [];

// The transport is stubbed rather than lib/pr/fixChecks, so the path and body
// that client builds stay under test.
stubSidecarApi({
  getHealth: async () => ({
    status: "ok",
    service: "sidecar",
    uptimeMs: 0,
    ready: true,
    phase: "ready" as const,
  }),
  waitForSidecarReady: async () => {},
  getStatus: async () => ({
    service: "sidecar",
    databaseConfigured: true,
    providers: { anthropic: false, gemini: false, cerebras: false, huggingface: false },
  }),
  getDbHealth: async () => ({ configured: true, reachable: true }),
  sidecarFetch: async (path: string, init: RequestInit = {}) => {
    sent.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
    const reply = replies.shift() ?? { status: 200, body: null };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  },
  streamSSE: async function* () {},
});

const ref: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 3 };

const check = (over: Partial<CheckItem> = {}): CheckItem => ({
  name: "build",
  status: "COMPLETED",
  conclusion: "SUCCESS",
  url: null,
  ...over,
});

const detail = (checks: CheckItem[], over: Partial<PrDetail> = {}) =>
  ({ state: "OPEN", headRef: "feat", fromFork: false, checks, ...over }) as PrDetail;

let unmount = () => {};

beforeEach(() => {
  sent.length = 0;
  replies = [];
});

afterEach(() => {
  unmount();
  invalidate(prDetailKey(ref));
});

afterAll(resetSidecarApi);

async function mount(d: PrDetail) {
  primeCache(prDetailKey(ref), d);
  const mounted = await mountForInteraction(createElement(WorkspaceFailingChecks, { prRef: ref }));
  unmount = mounted.unmount;
  return mounted.host;
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label);

describe("WorkspaceFailingChecks", () => {
  it("lists the failing checks apart from the rest, with a button to fix them", async () => {
    const host = await mount(
      detail([
        check({ name: "lint", conclusion: "FAILURE" }),
        check({ name: "unit" }),
        check({ name: "e2e", status: "IN_PROGRESS", conclusion: null }),
      ]),
    );
    const failing = host.querySelector("[data-testid=failing-checks]");
    expect(failing?.textContent).toContain("1 failing check");
    expect(failing?.textContent).toContain("lint");
    expect(failing?.textContent).not.toContain("unit");
    expect(host.textContent).toContain("All checks");
    expect(host.textContent).toContain("e2e");
    expect(button(host, "Fix with Claude")).toBeDefined();
  });

  it("offers nothing to fix when no check has failed", async () => {
    const host = await mount(detail([check({ name: "unit" })]));
    expect(host.querySelector("[data-testid=failing-checks]")).toBeNull();
    expect(button(host, "Fix with Claude")).toBeUndefined();
  });

  it("can't hand a fork's checks to an agent", async () => {
    const host = await mount(detail([check({ conclusion: "FAILURE" })], { fromFork: true }));
    expect(button(host, "Fix with Claude")?.disabled).toBe(true);
  });

  it("sends the ref and reports the agent it reached", async () => {
    replies = [{ status: 200, body: { outcome: "sent", workspaceId: "w1", name: "Payments" } }];
    const host = await mount(detail([check({ conclusion: "FAILURE" })]));

    button(host, "Fix with Claude")?.click();
    await waitFor(() => (host.textContent ?? "").includes("Sent to the agent"), "the result");

    expect(sent).toEqual([{ path: "/api/pr/fix-checks", body: { ref, confirm: false } }]);
    expect(host.textContent).toContain("Sent to the agent in “Payments”.");
  });

  it("asks before interrupting a busy agent, then sends with confirm", async () => {
    replies = [
      {
        status: 200,
        body: { outcome: "needs_confirm", workspaceId: "w1", name: "Payments", reason: "Busy." },
      },
      { status: 200, body: { outcome: "sent", workspaceId: "w1", name: "Payments" } },
    ];
    const host = await mount(detail([check({ conclusion: "FAILURE" })]));

    button(host, "Fix with Claude")?.click();
    await waitFor(() => button(host, "Send anyway") !== undefined, "the confirmation");
    expect(host.textContent).toContain("Busy. Send anyway?");

    button(host, "Send anyway")?.click();
    await waitFor(() => (host.textContent ?? "").includes("Sent to the agent"), "the result");
    expect(sent.map((s) => s.body?.confirm)).toEqual([false, true]);
  });

  it("shows why the sidecar refused", async () => {
    replies = [{ status: 400, body: { error: "this pull request has no failing checks" } }];
    const host = await mount(detail([check({ conclusion: "FAILURE" })]));

    button(host, "Fix with Claude")?.click();
    await waitFor(() => host.querySelector("[role=alert]") !== null, "the error");
    expect(host.querySelector("[role=alert]")?.textContent).toContain("no failing checks");
  });
});
