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

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

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
  return { host: mounted.host, details, scrolls };
}

async function jump(details: HTMLElement): Promise<void> {
  details.dispatchEvent(new Event(JUMP_TO_FILE_EVENT));
  await settle();
}

describe("PrFileDiffs jump to file", () => {
  // A viewed file starts collapsed and has no approach observer, so nothing but
  // the jump itself would ever open it.
  it("opens a viewed file it was asked to jump to", async () => {
    const { details } = await mountDiffs([file("a.ts")], "a.ts", new Set(["a.ts"]));
    expect(details.open).toBe(false);

    await jump(details);

    expect(details.open).toBe(true);
  });

  it("opens a file folded by Collapse all", async () => {
    const { host, details } = await mountDiffs([file("a.ts")], "a.ts");
    const collapseAll = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Collapse all",
    );
    collapseAll?.click();
    await settle();
    expect(details.open).toBe(false);

    await jump(details);

    expect(details.open).toBe(true);
  });

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

  // Files opening above the target after it lands are what pushed it away; the
  // jump has to keep it pinned, not only arrive.
  it("holds the landing while content above it grows", async () => {
    const { host, details } = await mountDiffs([file("a.ts"), file("b.ts")], "b.ts");
    host.setAttribute("data-pr-scroll", "");
    const layout = { above: 0 };
    let scrollTop = 0;
    Object.defineProperty(host, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    host.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    details.getBoundingClientRect = () => ({ top: layout.above - scrollTop }) as DOMRect;

    await jump(details);
    layout.above = 300;
    await settle();

    expect(host.scrollTop).toBe(300);
  });
});
