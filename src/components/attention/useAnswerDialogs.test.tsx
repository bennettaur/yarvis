import { afterEach, describe, expect, it } from "bun:test";
import type { AttentionItem } from "../../lib/attention";
import { mountForInteraction, waitFor } from "../../test/render";
import { AUTO_OPEN_ARMING_MS } from "./PermissionRequestModal";
import { useAnswerDialogs } from "./useAnswerDialogs";

function item(overrides: Partial<AttentionItem> & { id: string; seq: number }): AttentionItem {
  return {
    source: "claude-hook",
    sessionKey: "ws:w1/t1/p1",
    workspaceId: "w1",
    kind: "permission",
    title: "Fix API",
    body: "Needs permission",
    status: "pending",
    navTarget: { type: "workspace-claude", workspaceId: "w1" },
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z",
    ...overrides,
  };
}

type Dialogs = ReturnType<typeof useAnswerDialogs>;

let pending: AttentionItem[] = [];
let dialogs: Dialogs;
let unmount: (() => void) | null = null;

function Probe() {
  dialogs = useAnswerDialogs(() => pending);
  return null;
}

async function mount() {
  ({ unmount } = await mountForInteraction(<Probe />, 0));
}

afterEach(() => {
  unmount?.();
  unmount = null;
  pending = [];
});

const permission = item({ id: "perm", seq: 3 });
const question = item({
  id: "question",
  seq: 1,
  source: "system",
  kind: "question",
  sessionKey: "ws:w1/t2/p1",
});
const headsDown = item({
  id: "hd",
  seq: 2,
  source: "system",
  kind: "permission",
  sessionKey: "heads-down:q1",
  workspaceId: null,
  navTarget: { type: "heads-down" },
});

describe("useAnswerDialogs", () => {
  it("opens each kind of prompt in its own dialog", async () => {
    await mount();
    dialogs.open(permission, "click");
    dialogs.open(question, "click");
    dialogs.open(headsDown, "click");
    await waitFor(() => dialogs.headsDownItem !== null, "the dialogs to open");
    expect(dialogs.permissionItem?.id).toBe("perm");
    expect(dialogs.questionItem?.id).toBe("question");
    expect(dialogs.headsDownItem?.id).toBe("hd");
    expect(dialogs.anyOpen).toBe(true);
  });

  it("leaves an item with no dialog to the caller", async () => {
    await mount();
    expect(dialogs.open(item({ id: "idle", seq: 1, kind: "idle" }), "click")).toBe(false);
    expect(dialogs.anyOpen).toBe(false);
  });

  it("keeps the dialog's own click delay for a click, and lengthens it otherwise", async () => {
    await mount();
    dialogs.open(permission, "click");
    await waitFor(() => dialogs.permissionItem !== null, "the dialog to open");
    expect(dialogs.armingMs).toBeUndefined();

    dialogs.open(question, "auto");
    await waitFor(() => dialogs.questionItem !== null, "the auto-opened dialog");
    expect(dialogs.armingMs).toBe(AUTO_OPEN_ARMING_MS);
  });

  it("opens the workspace's next prompt once one is answered, with clicks held off", async () => {
    pending = [permission, question, item({ id: "later", seq: 9, sessionKey: "ws:w1/t3/p1" })];
    await mount();
    dialogs.open(permission, "click");
    await waitFor(() => dialogs.permissionItem !== null, "the dialog to open");

    dialogs.finishPermission();
    await waitFor(() => dialogs.questionItem !== null, "the next prompt");
    expect(dialogs.permissionItem).toBeNull();
    expect(dialogs.questionItem?.id).toBe("question");
    expect(dialogs.armingMs).toBe(AUTO_OPEN_ARMING_MS);
  });

  it("just closes when nothing else in the workspace waits", async () => {
    pending = [question];
    await mount();
    dialogs.open(question, "click");
    await waitFor(() => dialogs.questionItem !== null, "the dialog to open");

    dialogs.finishQuestion();
    await waitFor(() => dialogs.questionItem === null, "the dialog to close");
    expect(dialogs.anyOpen).toBe(false);
  });

  it("ignores a reply that finishes after its dialog was closed", async () => {
    pending = [question, permission];
    await mount();
    dialogs.open(question, "click");
    await waitFor(() => dialogs.questionItem !== null, "the dialog to open");
    const lateFinish = dialogs.finishQuestion;

    dialogs.closeQuestion();
    await waitFor(() => dialogs.questionItem === null, "the dialog to close");
    lateFinish();
    // Anything the late reply set would commit with this.
    dialogs.open(headsDown, "click");
    await waitFor(() => dialogs.headsDownItem !== null, "the heads-down dialog");
    expect(dialogs.questionItem).toBeNull();
    expect(dialogs.permissionItem).toBeNull();
  });

  it("ignores a late reply once another prompt took the dialog", async () => {
    const other = item({ id: "other", seq: 4, sessionKey: "ws:w1/t5/p1" });
    pending = [permission, other, question];
    await mount();
    dialogs.open(permission, "click");
    await waitFor(() => dialogs.permissionItem !== null, "the dialog to open");
    const lateFinish = dialogs.finishPermission;

    dialogs.open(other, "click");
    await waitFor(() => dialogs.permissionItem?.id === "other", "the other prompt");
    lateFinish();
    dialogs.open(headsDown, "click");
    await waitFor(() => dialogs.headsDownItem !== null, "the heads-down dialog");
    expect(dialogs.permissionItem?.id).toBe("other");
    expect(dialogs.questionItem).toBeNull();
  });
});
