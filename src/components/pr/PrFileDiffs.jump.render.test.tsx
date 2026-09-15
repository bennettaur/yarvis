import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrFile, PrRef } from "../../lib/pr/types";
import { prFile as file, setPrFiles } from "../../test/prFiles";
import { mountForInteraction } from "../../test/render";
import { FLASH_ATTR } from "./flashFile";
import { JUMP_TO_FILE_EVENT, prFileAnchorId } from "./shared";

// Imported after the shared stub so its usePrFiles mock is in place.
const { default: PrFileDiffs } = await import("./PrFileDiffs");

const prRef: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 1 };

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/** Mounts the diffs, then returns the target's `<details>` with its scroll calls recorded. */
async function mountDiffs(data: PrFile[], target: string, viewed = new Set<string>()) {
  setPrFiles(data);
  const mounted = await mountForInteraction(
    createElement(PrFileDiffs, { prRef, viewed, onToggleViewed: () => {} }),
  );
  cleanup = mounted.unmount;
  const details = document.getElementById(prFileAnchorId(prRef, target)) as HTMLDetailsElement;
  const scrolls: (ScrollIntoViewOptions | boolean | undefined)[] = [];
  details.scrollIntoView = (options) => scrolls.push(options);
  return { details, scrolls };
}

async function jump(details: HTMLElement): Promise<void> {
  details.dispatchEvent(new Event(JUMP_TO_FILE_EVENT));
  await new Promise((resolve) => setTimeout(resolve, 100));
}

describe("PrFileDiffs jump to file", () => {
  // A viewed file starts collapsed and has no approach observer, so nothing but
  // the jump itself would ever open it.
  it("opens a collapsed file it was asked to jump to", async () => {
    const { details } = await mountDiffs([file("a.ts")], "a.ts", new Set(["a.ts"]));
    expect(details.open).toBe(false);

    await jump(details);

    expect(details.open).toBe(true);
  });

  // Smooth travel is what dragged the files in between into expanding and moved
  // the target out from under the animation.
  it("scrolls the file's top into view without animating", async () => {
    const { details, scrolls } = await mountDiffs([file("a.ts"), file("b.ts")], "b.ts");

    await jump(details);

    expect(scrolls).toEqual([{ block: "start" }]);
  });

  it("flashes the file's header once it lands", async () => {
    const { details } = await mountDiffs([file("a.ts")], "a.ts");

    await jump(details);

    expect(details.querySelector("summary")?.hasAttribute(FLASH_ATTR)).toBe(true);
  });
});
