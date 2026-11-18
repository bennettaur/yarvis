import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { prDetailKey } from "../../../lib/pr/cache";
import type { PrDetail, PrRef } from "../../../lib/pr/types";
import { primeCache } from "../../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";
import { mountForInteraction, textOf, waitFor } from "../../../test/render";
import { reviewThread } from "../../../test/reviewThread";
import { CommentsTab } from "./StaticTabs";
import type { TabContext, TabSpec } from "./types";

const ref: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 7 };
const opened: TabSpec[] = [];
const ctx: TabContext = {
  workspaceId: "ws",
  pr: { id: "pr1", ref } as ReviewWorkspacePr,
  prRef: ref,
  diffMode: "split",
  openTab: (spec) => opened.push(spec),
  openSetup: () => {},
};

// Every read comes from the cache, primed fresh, so nothing goes to a client.
async function mount(detail: Partial<PrDetail>) {
  primeCache(prDetailKey(ref), { reviewThreads: [], ...detail } as PrDetail);
  const mounted = await mountForInteraction(createElement(CommentsTab, { ctx }));
  unmount = mounted.unmount;
  return mounted.host;
}

let unmount = () => {};
afterEach(() => {
  unmount();
  opened.length = 0;
});

describe("CommentsTab", () => {
  it("lists the conversation, then open threads by file with a jump to the line", async () => {
    primeCache(prDetailKey(ref), {
      conversation: [{ id: "c1", author: "maya", body: "Could you split this up?", createdAt: "" }],
      reviewThreads: [
        { ...reviewThread({ path: "src/a.ts", bodies: ["Off by one here"] }), line: 12 },
        {
          ...reviewThread({ id: "T2", path: "src/b.ts", bodies: ["Fixed already"] }),
          isResolved: true,
        },
      ],
    } as unknown as PrDetail);
    const mounted = await mountForInteraction(createElement(CommentsTab, { ctx }));
    unmount = mounted.unmount;
    const text = textOf(mounted.host.innerHTML);
    expect(text).toContain("Conversation");
    expect(text).toContain("Could you split this up?");
    expect(text).toContain("Off by one here");
    expect(text).not.toContain("Fixed already");
    expect(text).toContain("1 open · 1 resolved");

    [...mounted.host.querySelectorAll("button")]
      .find((b) => b.textContent?.startsWith("Go to line 12"))
      ?.click();
    expect(opened).toEqual([{ kind: "diff", prId: "pr1", path: "src/a.ts", revealLine: 12 }]);
  });

  it("shows general threads before the files, and resolved ones only on request", async () => {
    const host = await mount({
      reviewThreads: [
        reviewThread({ id: "G", path: null, line: null, bodies: ["Overall this reads well"] }),
        reviewThread({ id: "R", path: "src/b.ts", bodies: ["Fixed already"], isResolved: true }),
      ],
    });
    const text = () => textOf(host.innerHTML);
    expect(text()).toContain("Overall this reads well");
    expect(text()).not.toContain("Fixed already");
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Show resolved")?.click();
    await waitFor(() => text().includes("Fixed already"), "the resolved thread");
    expect(text().indexOf("Overall this reads well")).toBeLessThan(text().indexOf("src/b.ts"));
  });

  it("says when there are more threads or comments than were loaded", async () => {
    const host = await mount({
      reviewThreadsTruncated: true,
      conversationTruncated: true,
      conversation: [{ id: "c1", author: "maya", body: "hi", createdAt: "" }],
    });
    const text = textOf(host.innerHTML);
    expect(text).toContain("more threads than were loaded");
    expect(text).toContain("Showing the latest 1");
  });

  it("says when there is nothing to read", async () => {
    expect(textOf((await mount({})).innerHTML)).toContain("No comments yet.");
  });
});
