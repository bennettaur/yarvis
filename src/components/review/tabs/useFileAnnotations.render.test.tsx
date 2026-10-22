import { afterEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { prDetailKey } from "../../../lib/pr/cache";
import type { PrDetail, PrRef } from "../../../lib/pr/types";
import { primeCache } from "../../../lib/resourceCache";
import { mountForInteraction } from "../../../test/render";
import { type FileAnnotations, useFileAnnotations } from "./useFileAnnotations";

const ref: PrRef = { provider: "github", owner: "acme", repo: "widgets", number: 7 };
let latest: FileAnnotations | null = null;

function Harness({ canComment }: { canComment: boolean }) {
  latest = useFileAnnotations({
    prRef: ref,
    path: "src/a.ts",
    headContent: "one\ntwo\nthree\n",
    headSha: "h",
    canComment,
  });
  return null;
}

let unmount = () => {};
afterEach(() => {
  unmount();
  latest = null;
});

async function mount(canComment: boolean) {
  primeCache(prDetailKey(ref), { reviewThreads: [] } as unknown as PrDetail);
  const mounted = await mountForInteraction(createElement(Harness, { canComment }));
  unmount = mounted.unmount;
}

describe("useFileAnnotations.onLineAction", () => {
  it("says why a comment can't go on a file the PR doesn't change", async () => {
    await mount(false);
    await act(async () =>
      latest?.onLineAction({ kind: "comment", side: "RIGHT", startLine: 2, endLine: 2 }),
    );
    expect(latest?.notice).toBe("Comments go on files the pull request changes.");
    await act(async () => latest?.dismissNotice());
    expect(latest?.notice).toBeNull();
  });

  it("opens a composer on a changed file, with no notice", async () => {
    await mount(true);
    await act(async () =>
      latest?.onLineAction({ kind: "comment", side: "LEFT", startLine: 1, endLine: 3 }),
    );
    expect(latest?.notice).toBeNull();
    expect(latest?.zones.some((z) => z.id.startsWith("comment:"))).toBe(true);
  });

  it("asks questions only about the new version of the file", async () => {
    await mount(true);
    await act(async () =>
      latest?.onLineAction({ kind: "ask", side: "LEFT", startLine: 1, endLine: 1 }),
    );
    expect(latest?.notice).toBe("Questions are asked about the new version of the file.");
  });
});
