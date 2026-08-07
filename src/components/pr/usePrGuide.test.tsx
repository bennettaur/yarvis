import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { createElement, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import * as api from "../../lib/api";
import type { PrGuide } from "../../lib/pr/guide";
import type { PrRef } from "../../lib/pr/types";
import { type GuideController, usePrGuide } from "./usePrGuide";

/**
 * Drives the controller the way the panel's buttons do, because the wiring is
 * the part worth testing: which files a move hands to the caller that ticks
 * them off, and which moves hand over nothing at all.
 */

const ref: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 7 };

const steps = [
  { path: "src/api.ts", startLine: 10, endLine: 20, explanation: "the request arrives" },
  {
    path: "a.test.ts",
    startLine: null,
    endLine: null,
    explanation: "checked the tests",
    kind: "tests" as const,
    covers: ["b.test.ts", "c.test.ts"],
  },
];

const stored: PrGuide = {
  headSha: "a".repeat(40),
  steps,
  currentStep: 0,
  stale: false,
  createdAt: "",
};

// Only the transport is stubbed, so the real client code — including the query
// the guide routes are addressed by — still runs. A spy rather than
// `mock.module`, which would answer for every file loaded after this one.
const sidecarFetch = spyOn(api, "sidecarFetch").mockImplementation(async (path: string) => {
  const body = path.startsWith("/api/pr/guide?") ? { guide: stored } : { currentStep: 0 };
  return new Response(JSON.stringify(body), { status: 200 });
});

afterAll(() => {
  sidecarFetch.mockRestore();
});

/**
 * Mounts the hook, waits for its guide to load, then runs `drive` against the
 * controller. Returns the paths handed to `onStepRead`, in the order they came.
 */
async function drive(
  run: (controller: GuideController) => void | Promise<void>,
  startAt = 0,
): Promise<string[][]> {
  const read: string[][] = [];
  function Harness() {
    const guide = usePrGuide(ref, "title", "url", (paths) => read.push(paths));
    const driven = useRef(false);
    useEffect(() => {
      if (driven.current || !guide.guide) return;
      // Land on the step under test first, and let that render before driving:
      // the moves read the guide the hook last rendered, so a jump and a move
      // in one pass would both act on the step the reader started from. `goTo`
      // never reports, so the trip does not add to what the assertions see.
      if (guide.guide.currentStep !== startAt) {
        guide.goTo(startAt);
        return;
      }
      driven.current = true;
      void run(guide);
    });
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(Harness));
  await new Promise((r) => setTimeout(r, 60));
  root.unmount();
  host.remove();
  return read;
}

describe("usePrGuide", () => {
  // The whole point of the sanity-check step: one move finishes every file it
  // stood in for, not just the one it points at.
  it("reports every file a step covered when the reader moves on", async () => {
    const read = await drive((guide) => guide.next(), 1);
    expect(read).toEqual([["a.test.ts", "b.test.ts", "c.test.ts"]]);
  });

  it("reports the step's own file when it covers nothing else", async () => {
    const read = await drive((guide) => guide.next());
    expect(read).toEqual([["src/api.ts"]]);
  });

  // Going back is re-reading, not un-reading.
  it("reports nothing when the reader goes back", async () => {
    const read = await drive((guide) => guide.back(), 1);
    expect(read).toEqual([]);
  });

  it("reports nothing when the reader jumps to a step", async () => {
    const read = await drive((guide) => guide.goTo(1));
    expect(read).toEqual([]);
  });

  // The last step has nothing after it to move past, so finishing is the only
  // thing that can credit its files — often a whole sanity check's worth.
  it("reports the last step's files when the tour is finished", async () => {
    const read = await drive((guide) => guide.finish(), 1);
    expect(read).toEqual([["a.test.ts", "b.test.ts", "c.test.ts"]]);
  });
});

describe("usePrGuide focus", () => {
  it("follows the current step until sent somewhere else", async () => {
    let seen: GuideController["focus"] = null;
    function Harness() {
      const guide = usePrGuide(ref, "title", "url");
      seen = guide.focus;
      const driven = useRef(false);
      useEffect(() => {
        if (driven.current || !guide.guide) return;
        driven.current = true;
        guide.focusOn({ path: "src/other.ts", startLine: 3, endLine: 3 });
      });
      return null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(createElement(Harness));
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toMatchObject({ path: "src/other.ts", startLine: 3, endLine: 3 });
    root.unmount();
    host.remove();
  });
});
