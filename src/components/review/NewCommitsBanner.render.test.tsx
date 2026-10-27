import { afterEach, describe, expect, it } from "bun:test";
import { createElement, useState } from "react";
import type { PrRef } from "../../lib/pr/types";
import type { ReviewProgressEvent, ReviewWorkspacePr } from "../../lib/reviewWorkspaces/api";
import { mountForInteraction, renderToHtml, textOf, waitFor } from "../../test/render";
import { resetReviewApi, stubReviewApi } from "../../test/reviewWorkspacesApi";
import NewCommitsBanner, { hasNewCommits } from "./NewCommitsBanner";

const ref: PrRef = { provider: "github", owner: "acme", repo: "widgets", number: 7 };
const sha = (c: string) => c.repeat(40);
const pr = { id: "pr1", ref, status: "ready", headSha: sha("a") } as ReviewWorkspacePr;

let unmount = () => {};
afterEach(() => {
  unmount();
  resetReviewApi();
});

describe("hasNewCommits", () => {
  it("only when the checkout is ready and the provider's head is another commit", () => {
    expect(hasNewCommits(pr, sha("b"))).toBe(true);
    expect(hasNewCommits(pr, sha("a"))).toBe(false);
    expect(hasNewCommits(pr, undefined)).toBe(false);
    expect(hasNewCommits({ ...pr, status: "cloning" }, sha("b"))).toBe(false);
  });
});

describe("NewCommitsBanner", () => {
  const props = {
    workspaceId: "ws",
    pr,
    readOnly: false,
    onRefreshed: () => {},
    onSeeChanges: () => {},
  };

  it("stays out of the way while the checkout is current", async () => {
    const html = await renderToHtml(
      createElement(NewCommitsBanner, { ...props, providerHead: sha("a") }),
    );
    expect(textOf(html)).toBe("");
  });

  it("refreshes, follows the run, and then offers what changed since the review", async () => {
    const refreshed: string[] = [];
    let reread = 0;
    let seen = 0;
    stubReviewApi({
      refreshReviewPr: async (_ws, prId) => {
        refreshed.push(prId);
        return pr;
      },
      followReviewPrProgress: async function* (): AsyncGenerator<ReviewProgressEvent> {
        yield { type: "start", phase: "refresh" };
        yield { type: "log", text: "Fetching feature and main\n" };
        yield { type: "done", phase: "refresh", status: "ready", error: null };
      },
    });
    const mounted = await mountForInteraction(
      createElement(NewCommitsBanner, {
        ...props,
        providerHead: sha("b"),
        onRefreshed: () => {
          reread++;
        },
        onSeeChanges: () => {
          seen++;
        },
      }),
    );
    unmount = mounted.unmount;
    expect(mounted.host.textContent).toContain("New commits pushed");
    const button = (label: string) =>
      [...mounted.host.querySelectorAll("button")].find((b) => b.textContent === label);
    button("Refresh")?.click();
    await waitFor(() => button("See what changed since you last reviewed") !== undefined, "done");
    expect(refreshed).toEqual(["pr1"]);
    expect(reread).toBe(1);
    button("See what changed since you last reviewed")?.click();
    expect(seen).toBe(1);
  });

  it("after a refresh, offers another one if newer commits were pushed meanwhile", async () => {
    stubReviewApi({
      refreshReviewPr: async () => pr,
      followReviewPrProgress: async function* (): AsyncGenerator<ReviewProgressEvent> {
        yield { type: "done", phase: "refresh", status: "ready", error: null };
      },
    });
    let setHead: (head: string) => void = () => {};
    function Harness() {
      const [head, set] = useState(sha("b"));
      setHead = set;
      return createElement(NewCommitsBanner, { ...props, providerHead: head });
    }
    const mounted = await mountForInteraction(createElement(Harness));
    unmount = mounted.unmount;
    const button = (label: string) =>
      [...mounted.host.querySelectorAll("button")].find((b) => b.textContent === label);
    button("Refresh")?.click();
    await waitFor(() => !!mounted.host.textContent?.includes("Checkout updated"), "done");
    // The poll sees a push the refresh didn't fetch.
    setHead(sha("c"));
    await waitFor(() => !!mounted.host.textContent?.includes("New commits pushed"), "behind again");
    expect(mounted.host.textContent).not.toContain("Checkout updated");
    expect(button("Refresh")).toBeDefined();
  });

  it("a failed refresh can be dismissed", async () => {
    stubReviewApi({
      refreshReviewPr: async () => pr,
      followReviewPrProgress: async function* (): AsyncGenerator<ReviewProgressEvent> {
        yield { type: "done", phase: "refresh", status: "ready", error: "fetch failed" };
      },
    });
    const mounted = await mountForInteraction(
      createElement(NewCommitsBanner, { ...props, providerHead: sha("b") }),
    );
    unmount = mounted.unmount;
    const button = (label: string) =>
      [...mounted.host.querySelectorAll("button")].find(
        (b) => b.textContent === label || b.getAttribute("aria-label") === label,
      );
    button("Refresh")?.click();
    await waitFor(() => !!mounted.host.textContent?.includes("Update failed"), "the failure");
    button("Dismiss")?.click();
    await waitFor(() => !mounted.host.textContent?.includes("Update failed"), "dismissed");
    expect(mounted.host.textContent).toContain("New commits pushed");
  });

  it("offers no refresh in an archived workspace", async () => {
    const html = await renderToHtml(
      createElement(NewCommitsBanner, { ...props, readOnly: true, providerHead: sha("b") }),
    );
    expect(textOf(html)).toContain("New commits pushed");
    expect(html).not.toContain(">Refresh<");
  });
});
