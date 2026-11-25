import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrRef } from "../../../lib/pr/types";
import { clearResourceCache } from "../../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";
import { inlineDrafts, type ReviewDraft } from "../../../lib/reviewWorkspaces/drafts";
import { mountForInteraction, waitFor } from "../../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../../test/sidecarApi";
import { DraftBlock, DraftsBar, useDraftActions } from "./ReviewDrafts";
import { useReviewDrafts } from "./reviewData";
import type { TabContext } from "./types";

const HEAD = "h".repeat(40);
const prRef: PrRef = { provider: "github", owner: "o", repo: "r", number: 7 };
const ctx = {
  workspaceId: "ws",
  pr: { id: "pr", headSha: HEAD, baseSha: null, mergeBaseSha: "b".repeat(40) } as ReviewWorkspacePr,
  prRef,
  diffMode: "split",
  openTab: () => {},
} as unknown as TabContext;
const KEY = "test:drafts";

const draft = (over: Partial<ReviewDraft>): ReviewDraft => ({
  id: "d1",
  source: "verification",
  label: "Test quality",
  path: "src/a.ts",
  line: 4,
  headSha: HEAD,
  title: "Untested branch",
  body: "**Untested branch** (verification report: Test quality)\n\n> No test covers it",
  editedBody: null,
  status: "open",
  outcome: null,
  stale: false,
  ...over,
});

const last = <T,>(list: readonly T[]): T | undefined => list[list.length - 1];

let stored: ReviewDraft[];
let requests: { method: string; url: string; body: unknown }[];

/** The sidecar's draft routes, over `stored`. */
function fakeSidecar() {
  stubSidecarApi({
    sidecarFetch: async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, url, body });
      const reply = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), { status });
      if (method === "GET") return reply({ headSha: HEAD, drafts: stored });
      if (method === "PATCH") {
        const id = last(url.split("/"));
        stored = stored.map((d) =>
          d.id !== id
            ? d
            : body.action === "accept"
              ? {
                  ...d,
                  status: "accepted",
                  outcome: body.body ? "edited" : "accepted",
                  editedBody: body.body ?? null,
                }
              : body.action === "drop"
                ? { ...d, status: "dropped", outcome: "dropped" }
                : { ...d, status: "open", outcome: null },
        );
        return reply(stored.find((d) => d.id === id));
      }
      const accepted = stored.filter((d) => d.status === "accepted");
      stored = stored.map((d) => (d.status === "accepted" ? { ...d, status: "posted" } : d));
      return reply({ posted: accepted.length }, 201);
    },
  });
}

function Harness() {
  const drafts = useReviewDrafts(ctx.workspaceId, ctx.pr.id, KEY);
  const actions = useDraftActions(ctx, KEY, drafts.refresh);
  const list = drafts.data?.drafts ?? [];
  return createElement(
    "div",
    null,
    createElement(DraftsBar, { ctx, drafts: list, actions, onJump: () => {} }),
    ...inlineDrafts(list, "src/a.ts", HEAD).map((d) =>
      createElement(DraftBlock, { key: d.id, draft: d, actions }),
    ),
  );
}

let unmount: (() => void) | null = null;
async function mount() {
  const mounted = await mountForInteraction(createElement(Harness));
  unmount = mounted.unmount;
  return mounted.host;
}

const button = (host: Element, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label) as
    | HTMLButtonElement
    | undefined;

function typeInto(field: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(field);
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  clearResourceCache();
  requests = [];
  fakeSidecar();
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

afterAll(() => {
  resetSidecarApi();
  clearResourceCache();
});

describe("review drafts", () => {
  it("renders model text as markdown, never as HTML", async () => {
    stored = [
      draft({
        body: '**Bold title**\n\n> <img src="x" onerror="alert(1)"> <b>raw</b> <script>x()</script>',
      }),
    ];
    const host = await mount();
    await waitFor(() => host.textContent?.includes("Bold title") ?? false, "the draft");
    expect(host.querySelector("strong")?.textContent).toBe("Bold title");
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("b")).toBeNull();
    expect(host.querySelector("script")).toBeNull();
    expect(host.textContent).toContain("Draft");
    expect(host.textContent).toContain("Test quality · verification");
  });

  it("posts nothing until the user accepts and posts", async () => {
    stored = [draft({}), draft({ id: "d2", line: 9, title: "Second", body: "Second body" })];
    const host = await mount();
    await waitFor(() => host.textContent?.includes("2 to answer") ?? false, "the bar");
    expect(button(host, "Post 1 as one review")).toBeUndefined();
    expect(requests.every((r) => r.method === "GET")).toBe(true);

    button(host, "Accept")?.click();
    await waitFor(() => host.textContent?.includes("1 accepted") ?? false, "the accept");
    expect(last(requests)).toMatchObject({
      method: "PATCH",
      url: "/api/review-workspaces/ws/prs/pr/drafts/d1",
      body: { action: "accept" },
    });
    expect(host.textContent).toContain("Posts with the review");

    typeInto(
      host.querySelector('input[aria-label="Review summary"]') as HTMLInputElement,
      "Looks close",
    );
    button(host, "Post 1 as one review")?.click();
    await waitFor(() => host.textContent?.includes("Posted 1 comment.") ?? false, "the post");
    const post = requests.find((r) => r.method === "POST");
    expect(post).toMatchObject({
      url: "/api/review-workspaces/ws/prs/pr/drafts/post",
      body: { summary: "Looks close", headSha: HEAD },
    });
    // The posted draft leaves the diff; the undecided one stays.
    await waitFor(() => !host.textContent?.includes("Untested branch"), "the refresh");
    expect(host.textContent).toContain("Second body");
  });

  it("accepts the edited text, and drops a draft", async () => {
    stored = [draft({}), draft({ id: "d2", line: 9, title: "Second", body: "Second body" })];
    const host = await mount();
    await waitFor(() => host.textContent?.includes("2 to answer") ?? false, "the bar");

    button(host, "Edit")?.click();
    await waitFor(() => host.querySelector("textarea") !== null, "the editor");
    typeInto(host.querySelector("textarea") as HTMLTextAreaElement, "My own words");
    button(host, "Save and accept")?.click();
    await waitFor(() => host.textContent?.includes("Accepted, edited") ?? false, "the edit");
    expect(last(requests)?.body).toEqual({ action: "accept", body: "My own words" });
    expect(host.textContent).toContain("My own words");

    const drops = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Drop");
    last(drops)?.click();
    await waitFor(() => !host.textContent?.includes("Second body"), "the drop");
    expect(last(requests)?.body).toEqual({ action: "drop" });
  });

  it("lists a stale draft in the bar, not on its line", async () => {
    stored = [draft({ stale: true, status: "accepted", editedBody: "Kept" })];
    const host = await mount();
    await waitFor(() => host.textContent?.includes("Stale") ?? false, "the stale draft");
    expect(host.textContent).toContain("src/a.ts:4");
    expect(host.textContent).toContain("(edited)");
    expect(button(host, "Accept")).toBeUndefined();
    expect(button(host, "Post 1 as one review")).toBeUndefined();
  });
});

describe("inlineDrafts", () => {
  it("keeps the file's live drafts at the head on screen", () => {
    const list = [
      draft({ id: "a" }),
      draft({ id: "b", status: "accepted" }),
      draft({ id: "c", status: "dropped" }),
      draft({ id: "d", status: "posted" }),
      draft({ id: "e", stale: true }),
      draft({ id: "f", headSha: "o".repeat(40) }),
      draft({ id: "g", path: "other.ts" }),
    ];
    expect(inlineDrafts(list, "src/a.ts", HEAD).map((d) => d.id)).toEqual(["a", "b"]);
  });
});
