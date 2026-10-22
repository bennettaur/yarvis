import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { DiffSide, NewComment, PrFile, PrRef, ReviewThread } from "../../lib/pr/types";
import { reviewThread } from "../../test/reviewThread";
import { LineCommentBlock, type LineComments, useLineComments } from "./LineComments";

const sent: NewComment[] = [];
const threadWrites: string[] = [];

const record = async (comment: NewComment) => {
  sent.push(comment);
  return { ok: true };
};

/** Swapped per-test rather than re-mocking, since `mock.module` is global. */
let post: (comment: NewComment) => Promise<{ ok: boolean }> = record;
let threadWrite: (what: string) => Promise<{ ok: boolean }> = async (what) => {
  threadWrites.push(what);
  return { ok: true };
};

// mock.module is process-global in bun, so keep the module's other exports
// intact — anything else loading this module in the same run gets this object.
const actual = await import("../../lib/pr/api");
mock.module("../../lib/pr/api", () => ({
  ...actual,
  postPrComment: (_ref: PrRef, comment: NewComment) => post(comment),
  replyToPrThread: (_ref: PrRef, thread: ReviewThread, body: string) =>
    threadWrite(`reply ${thread.id} ${body}`),
  resolvePrThread: (_ref: PrRef, id: string) => threadWrite(`resolve ${id}`),
  unresolvePrThread: (_ref: PrRef, id: string) => threadWrite(`unresolve ${id}`),
}));

const prRef: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 1 };

const file: PrFile = {
  filename: "foo.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: "",
};

const thread = (line: number | null, body: string, side: DiffSide = "RIGHT"): ReviewThread =>
  reviewThread({ path: file.filename, line, side, bodies: [body] });

const right = (line: number) => ({ side: "RIGHT" as const, line });

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Mounts the hook behind the block that renders it, so a test can post through
 * it and then hand it a new set of threads — what a subscriber refetch does to
 * a file still on screen — and read back both the state and the markup.
 */
function mount(line: number, side: DiffSide = "RIGHT") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let latest: LineComments | null = null;

  function Harness({ threads }: { threads: ReviewThread[] }) {
    const comments = useLineComments(prRef, file, threads);
    latest = comments;
    return createElement(LineCommentBlock, { side, line, comments });
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
    host,
    dispose() {
      root.unmount();
      host.remove();
    },
  };
}

let view: ReturnType<typeof mount>;

beforeEach(() => {
  sent.length = 0;
  threadWrites.length = 0;
  post = record;
  threadWrite = async (what) => {
    threadWrites.push(what);
    return { ok: true };
  };
  view = mount(4);
});

afterEach(() => {
  view.dispose();
});

/** Mounts against no threads and posts one comment on line 4. */
async function posted(body: string): Promise<LineComments> {
  const comments = await view.render([]);
  await comments.submit(right(4), body);
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
    expect(refetched.threadsAt("RIGHT", 4)).toHaveLength(1);
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

  it("leaves an identical body on the other side of the same line alone", async () => {
    await posted("looks off");

    const refetched = await view.render([thread(4, "looks off", "LEFT")]);
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
    await comments.submit(right(4), "first");
    await comments.submit(right(4), "second");
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
    await expect(comments.submit(right(4), "looks off")).rejects.toThrow("nope");
    await settle();

    const after = await view.render([]);
    expect(after.pending).toEqual([]);
  });

  it("posts an old-side range with its side and start line", async () => {
    const comments = await view.render([]);
    await comments.submit({ side: "LEFT", line: 6, startLine: 3 }, "why?");
    expect(sent).toEqual([{ path: "foo.ts", line: 6, side: "LEFT", startLine: 3, body: "why?" }]);
  });

  it("grows the open composer into a range on shift-click", async () => {
    let comments = await view.render([]);
    comments.openComposer("RIGHT", 4);
    comments = await view.render([]);
    comments.openComposer("RIGHT", 9, true);
    comments = await view.render([]);
    expect(comments.composer).toEqual({ side: "RIGHT", line: 9, startLine: 4 });

    // Back up past the start: the range covers both ends.
    comments.openComposer("RIGHT", 2, true);
    comments = await view.render([]);
    expect(comments.composer).toEqual({ side: "RIGHT", line: 9, startLine: 2 });
  });

  it("starts over when a shift-click lands on the other side", async () => {
    let comments = await view.render([]);
    comments.openComposer("RIGHT", 4);
    comments = await view.render([]);
    comments.openComposer("LEFT", 9, true);
    comments = await view.render([]);
    expect(comments.composer).toEqual({ side: "LEFT", line: 9 });
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

  it("renders only the threads on its own side", async () => {
    await view.render([thread(4, "new side"), thread(4, "old side", "LEFT")]);
    expect(view.html).toContain("new side");
    expect(view.html).not.toContain("old side");
  });
});

describe("thread actions", () => {
  const button = (label: string) =>
    Array.from(view.host.querySelectorAll("button")).find((b) => b.textContent === label);

  it("resolves a thread and shows it resolved before the refetch agrees", async () => {
    const open = thread(4, "nit");
    const comments = await view.render([open]);
    await comments.threadActions.viewProps(open).onResolve?.();
    await view.render([open]);

    expect(threadWrites).toEqual([`resolve ${open.id}`]);
    expect(view.html).toContain("resolved");
    expect(button("Unresolve")).toBeDefined();
  });

  it("follows the server again once it has caught up", async () => {
    const open = thread(4, "nit");
    const comments = await view.render([open]);
    await comments.threadActions.viewProps(open).onResolve?.();
    await view.render([{ ...open, isResolved: true }]);

    // Someone reopened it elsewhere: that change must not be masked.
    await view.render([open]);
    expect(button("Resolve")).toBeDefined();
  });

  it("leaves the thread as it was when resolving fails", async () => {
    threadWrite = async () => {
      throw new Error("forbidden");
    };
    const open = thread(4, "nit");
    await view.render([open]);
    button("Resolve")?.click();
    await settle();

    expect(view.html).toContain("forbidden");
    expect(button("Resolve")).toBeDefined();
  });

  it("shows a reply until the refetched thread carries it", async () => {
    const open = thread(4, "nit");
    const comments = await view.render([open]);
    await comments.threadActions.viewProps(open).onReply?.("fixed");
    await view.render([open]);

    expect(threadWrites).toEqual([`reply ${open.id} fixed`]);
    expect(view.html).toContain("you · just now");

    await view.render([
      { ...open, comments: [...open.comments, { ...open.comments[0]!, id: "c2", body: "fixed" }] },
    ]);
    expect(view.html).not.toContain("you · just now");
    expect(view.html.split("fixed")).toHaveLength(2);
  });

  it("hides the controls the viewer may not use", async () => {
    await view.render([{ ...thread(4, "nit"), canReply: false, canResolve: false }]);
    expect(button("Reply")).toBeUndefined();
    expect(button("Resolve")).toBeUndefined();
  });
});
