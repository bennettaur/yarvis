import { afterEach, describe, expect, it } from "bun:test";
import { createElement, Fragment } from "react";
import { mountForInteraction, waitFor } from "../../test/render";
import { resetReviewApi, stubReviewApi } from "../../test/reviewWorkspacesApi";
import type { ReviewWorkspacePr } from "./api";
import { useReviewChangedFiles } from "./cache";

const pr = (over: Partial<ReviewWorkspacePr> = {}) =>
  ({ id: "pr1", headSha: "h", mergeBaseSha: "b", ...over }) as ReviewWorkspacePr;

function Consumer({ target }: { target: ReviewWorkspacePr }) {
  const { data } = useReviewChangedFiles("ws", target);
  return createElement("span", null, data ? `${data.files.length} files` : "none");
}

let unmount = () => {};
afterEach(() => {
  unmount();
  resetReviewApi();
});

describe("useReviewChangedFiles", () => {
  it("reads once for every view of the same PR", async () => {
    let reads = 0;
    stubReviewApi({
      reviewChangedFiles: async () => {
        reads++;
        return { headSha: "h", mergeBaseSha: "b", files: [] };
      },
    });
    const mounted = await mountForInteraction(
      createElement(
        Fragment,
        null,
        createElement(Consumer, { target: pr() }),
        createElement(Consumer, { target: pr() }),
      ),
    );
    unmount = mounted.unmount;
    await waitFor(() => (mounted.host.textContent ?? "").includes("0 files0 files"), "both views");
    expect(reads).toBe(1);
  });

  it("reads nothing until the PR's commits are known", async () => {
    let reads = 0;
    stubReviewApi({
      reviewChangedFiles: async () => {
        reads++;
        return { headSha: "h", mergeBaseSha: "b", files: [] };
      },
    });
    const mounted = await mountForInteraction(
      createElement(
        Fragment,
        null,
        createElement(Consumer, { target: pr({ headSha: null }) }),
        createElement(Consumer, { target: pr({ id: "pr2", mergeBaseSha: null }) }),
      ),
    );
    unmount = mounted.unmount;
    expect(mounted.host.textContent).toBe("nonenone");
    expect(reads).toBe(0);
  });
});
