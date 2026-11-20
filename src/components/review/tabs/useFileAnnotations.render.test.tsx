import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { act, createElement, Fragment } from "react";
import { prDetailKey } from "../../../lib/pr/cache";
import type { PrDetail, PrRef } from "../../../lib/pr/types";
import { primeCache } from "../../../lib/resourceCache";
import { resetPrApi, stubPrApi } from "../../../test/prApi";
import { mountForInteraction, waitFor } from "../../../test/render";
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
  // Rendered in place of the editor's view zones, so a test can use the composer.
  return createElement(
    Fragment,
    null,
    latest.zones.map((z) => createElement(Fragment, { key: z.id }, z.render())),
  );
}

let unmount = () => {};
let host: HTMLElement | null = null;
afterEach(() => {
  unmount();
  latest = null;
});
afterAll(() => resetPrApi());

async function mount(canComment: boolean) {
  primeCache(prDetailKey(ref), { reviewThreads: [] } as unknown as PrDetail);
  const mounted = await mountForInteraction(createElement(Harness, { canComment }));
  unmount = mounted.unmount;
  host = mounted.host;
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

describe("useFileAnnotations comment zones", () => {
  it("keeps a zone under the line for the note when GitHub moved the comment onto the file", async () => {
    stubPrApi({ postPrComment: async () => ({ ok: true, placement: "file" }) });
    await mount(true);
    await act(async () =>
      latest?.onLineAction({ kind: "comment", side: "RIGHT", startLine: 2, endLine: 2 }),
    );
    await waitFor(() => host?.querySelector("textarea") != null, "the composer");
    const box = host?.querySelector("textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        box,
        "outside the diff",
      );
      box?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      Array.from(host?.querySelectorAll("button") ?? [])
        .find((b) => b.textContent === "Comment")
        ?.click(),
    );

    await waitFor(
      () => (host?.textContent ?? "").includes("Posted on the whole file instead"),
      "the moved-to-file note",
    );
    expect(latest?.zones.map((z) => z.id)).toContain("comment:RIGHT:2");
  });
});
