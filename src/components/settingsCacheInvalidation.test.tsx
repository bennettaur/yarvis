import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { GITHUB_ISSUES_PREFIX, JIRA_ISSUES_PREFIX } from "../lib/issues/cacheKeys";
import { PRS_PROBE_PREFIX, prsListPrefix } from "../lib/pr/cacheKeys";
import { type Freshness, useCachedResource } from "../lib/resourceCache";
import { nativeInvoke } from "../test/nativeInvoke";
import { mountForInteraction } from "../test/render";

/**
 * A setting that changes what a cached panel may show has to drop that panel's
 * cache where it is saved — the panel is unmounted at the time and will not find
 * out otherwise. Getting the prefix wrong fails silently in both directions:
 * too narrow and the user stares at the answer they just changed, too wide and a
 * rate-limited provider is re-asked for data the setting never touched. These
 * are the call sites, tested through the buttons rather than by inspecting the
 * prefixes they pass.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let repos: unknown[] = [];
const config = { reviewQuery: "is:open", reviewingLookbackDays: 7 };

mock.module("../lib/api", () => ({
  sidecarInfo: async () => ({ port: 0, token: "test-token" }),
  // Faithful copy of the real implementation: a naive stub here would leak into
  // any other test file that runs in the same process (`mock.module` is
  // process-global, not file-scoped) and break its assertions about the actual
  // error-detail-extraction behavior.
  ensureOk: async (res: Response, context: string) => {
    if (res.ok) return;
    const raw = await res.text().catch(() => "");
    throw new Error(raw ? `${context} failed (${res.status}): ${raw}` : `${context} failed`);
  },
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
  sidecarFetch: async (path: string) => {
    if (path.startsWith("/api/repos")) return json(repos);
    if (path.startsWith("/api/github/config")) return json(config);
    return json([]);
  },
  streamSSE: async function* () {},
}));

// Delegates for everything it doesn't answer, per `src/test/nativeInvoke.ts`:
// this stub is live for every file that runs after it, so a command it drops
// would break an unrelated suite depending on file order.
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string) =>
    command === "list_secret_status" ? [] : nativeInvoke(command),
}));

const { default: ReposSection } = await import("./ReposSection");
const { default: PrReviewSection } = await import("./PrReviewSection");
const { default: KeychainSection } = await import("./KeychainSection");

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/** Long enough that nothing under test reloads on age alone. */
const HELD: Freshness = { ttlMs: 60_000, hardMs: 600_000 };

/** How many times each watched key has loaded, by key. */
const loads = new Map<string, number>();

/**
 * Mounts a subscriber on one cache key so a dropped entry shows up as a reload,
 * which is what a user sees: the panel goes and asks again.
 */
function watch(key: string) {
  loads.set(key, 0);
  return createElement(function Watcher() {
    const { data } = useCachedResource(
      key,
      async () => {
        loads.set(key, (loads.get(key) ?? 0) + 1);
        return key;
      },
      HELD,
    );
    return createElement("span", null, data ?? "-");
  });
}

const loadsOf = (key: string) => loads.get(key) ?? 0;

const button = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const mounted: (() => void)[] = [];

async function mount(element: ReturnType<typeof createElement>) {
  const view = await mountForInteraction(element);
  mounted.push(view.unmount);
  return view;
}

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  loads.clear();
  repos = [];
});

describe("settings that change what a cached panel may show", () => {
  it("drops the GitHub issue lists when a repo is saved, and leaves JIRA's alone", async () => {
    const github = `${GITHUB_ISSUES_PREFIX}assigned`;
    const jira = `${JIRA_ISSUES_PREFIX}assigned`;
    await mount(watch(github));
    await mount(watch(jira));
    expect(loadsOf(github)).toBe(1);

    const section = await mount(createElement(ReposSection));
    button(section.host, "Add repo")?.click();
    await settle(10);
    const cloneUrl = section.host.querySelector<HTMLInputElement>(
      'input[placeholder="git@github.com:owner/repo.git"]',
    );
    expect(cloneUrl).not.toBeNull();
    if (cloneUrl) type(cloneUrl, "git@github.com:octo/web.git");
    button(section.host, "Save")?.click();
    await settle();

    // Whether a repo pulls issues decides what the Issues tab may ask for.
    expect(loadsOf(github)).toBe(2);
    // Repo configuration says nothing about JIRA, which rate-limits.
    expect(loadsOf(jira)).toBe(1);
  });

  it("drops the PR lists when the review query is saved, and leaves the probes alone", async () => {
    const lists = `${prsListPrefix("github")}lists`;
    const probe = `${PRS_PROBE_PREFIX}github`;
    await mount(watch(lists));
    await mount(watch(probe));
    expect(loadsOf(lists)).toBe(1);

    const section = await mount(createElement(PrReviewSection));
    const query = section.host.querySelector<HTMLInputElement>("input");
    expect(query).not.toBeNull();
    if (query) type(query, "is:open review-requested:@me");
    button(section.host, "Save")?.click();
    await settle();

    // The needs-review query decides what one of those lists holds.
    expect(loadsOf(lists)).toBe(2);
    // It says nothing about whether GitHub is configured, and that probe is held
    // for ten minutes precisely so a tab switch never re-spends it.
    expect(loadsOf(probe)).toBe(1);
  });

  it("drops everything when a credential is saved", async () => {
    const github = `${GITHUB_ISSUES_PREFIX}assigned`;
    const probe = `${PRS_PROBE_PREFIX}github`;
    await mount(watch(github));
    await mount(watch(probe));

    const section = await mount(createElement(KeychainSection));
    const secret = section.host.querySelector<HTMLInputElement>("input");
    expect(secret).not.toBeNull();
    if (secret) type(secret, "ghp_something");
    button(section.host, "Save")?.click();
    await settle(120);

    // The sidecar was restarted under new credentials, so every answer in the
    // cache came from a process that no longer exists. Remounting is what picks
    // the new ones up — a cleared subscriber is not notified.
    await mount(watch(github));
    await mount(watch(probe));
    expect(loadsOf(github)).toBe(1);
    expect(loadsOf(probe)).toBe(1);
  });
});
