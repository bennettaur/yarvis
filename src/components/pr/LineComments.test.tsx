import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { NewComment, PrFile, PrRef, ReviewThread } from "../../lib/pr/types";
import { LineCommentBlock, type LineComments, useLineComments } from "./LineComments";

const sent: NewComment[] = [];

const record = async (comment: NewComment) => {
  sent.push(comment);
  return { ok: true };
};

/** Swapped per-test rather than re-mocking, since `mock.module` is global. */
let post: (comment: NewComment) => Promise<{ ok: boolean }> = record;

// mock.module is process-global in bun, so keep the module's other exports
// intact — anything else loading this module in the same run gets this object.
const actual = await import("../../lib/pr/api");
mock.module("../../lib/pr/api", () => ({
  ...actual,
  postPrComment: (_ref: PrRef, comment: NewComment) => post(comment),
}));

const prRef: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 1 };

const file: PrFile = {
  filename: "foo.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: "",
};

const thread = (line: number | null, body: string): ReviewThread => ({
  path: file.filename,
  line,
  isResolved: false,
  comments: [{ author: "you", body, createdAt: "2026-08-05T00:00:00.000Z" }],
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Mounts the hook behind the block that renders it, so a test can post through
 * it and then hand it a new set of threads — what a subscriber refetch does to
 * a file still on screen — and read back both the state and the markup.
 */
function mount(line: number) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let latest: LineComments | null = null;

  function Harness({ threads }: { threads: ReviewThread[] }) {
    const comments = useLineComments(prRef, file, threads);
    latest = comments;
    return createElement(LineCommentBlock, { line, comments });
  }

  return {
    async render(threads: ReviewThread[]) {
      root.render(createElement(Harness, { threads }));
      await settle();
      return latest as LineComments;
    },
    get html() {
      return host.innerHTML;
    },
    dispose() {
      root.unmount();
      host.remove();
    },
  };
}

let view: ReturnType<typeof mount>;

beforeEach(() => {
  sent.length = 0;
  post = record;
  view = mount(4);
});

afterEach(() => {
  view.dispose();
});

/** Mounts against no threads and posts one comment on line 4. */
async function posted(body: string): Promise<LineComments> {
  const comments = await view.render([]);
  await comments.submit(4, body);
  await settle();
  return await view.render([]);
}

describe("useLineComments", () => {
  it("shows a posted comment optimistically", async () => {
    const comments = await posted("looks off");

    expect(sent).toEqual([{ path: "foo.ts", line: 4, body: "looks off" }]);
    expect(comments.pending.map((p) => p.body)).toEqual(["looks off"]);
  });

  it("drops the optimistic copy once the refetched threads carry it", async () => {
    await posted("looks off");

    const refetched = await view.render([thread(4, "looks off")]);
    expect(refetched.pending).toEqual([]);
    expect(refetched.byLine.get(4)).toHaveLength(1);
  });

  it("keeps the optimistic copy when the refetch missed the comment", async () => {
    await posted("looks off");

    // A thread on the same line, but somebody else's — the provider hasn't
    // caught up with this session's write yet.
    const refetched = await view.render([thread(4, "unrelated")]);
    expect(refetched.pending.map((p) => p.body)).toEqual(["looks off"]);
  });

  it("matches a body the provider echoed back with its own line endings", async () => {
    await posted("first\nsecond");

    const refetched = await view.render([thread(4, "first\r\nsecond\n")]);
    expect(refetched.pending).toEqual([]);
  });

  it("leaves an identical body on another line alone", async () => {
    await posted("looks off");

    const refetched = await view.render([thread(9, "looks off")]);
    expect(refetched.pending.map((p) => p.body)).toEqual(["looks off"]);
  });

  it("does not resurrect a settled comment when its thread goes outdated", async () => {
    await posted("looks off");
    await view.render([thread(4, "looks off")]);

    // New commits pushed: the provider keeps the thread but drops its line, so
    // nothing on line 4 carries the body any more.
    const outdated = await view.render([thread(null, "looks off")]);
    expect(outdated.pending).toEqual([]);
  });

  it("keeps ids stable when an earlier comment settles", async () => {
    const comments = await view.render([]);
    await comments.submit(4, "first");
    await comments.submit(4, "second");
    await settle();

    const refetched = await view.render([thread(4, "first")]);
    expect(refetched.pending.map((p) => ({ id: p.id, body: p.body }))).toEqual([
      { id: 1, body: "second" },
    ]);
  });

  it("adds no optimistic copy when the post fails", async () => {
    post = async () => {
      throw new Error("nope");
    };
    const comments = await view.render([]);
    await expect(comments.submit(4, "looks off")).rejects.toThrow("nope");
    await settle();

    const after = await view.render([]);
    expect(after.pending).toEqual([]);
  });
});

describe("LineCommentBlock", () => {
  // The reported symptom: once the refetch lands, the body must appear as the
  // server's thread only, not alongside the optimistic card as well.
  it("renders a posted comment once after the refetch carries it", async () => {
    await posted("looks off");
    expect(view.html.split("looks off")).toHaveLength(2);

    await view.render([thread(4, "looks off")]);
    expect(view.html.split("looks off")).toHaveLength(2);
  });
});
