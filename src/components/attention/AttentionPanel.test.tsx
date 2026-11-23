import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { Alarm } from "../../lib/alarms";
import type { AttentionItem } from "../../lib/attention";
import { resetAlarms, setAlarms, stubAlarmsApi } from "../../test/alarmFixture";
import { mountForInteraction, waitFor } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";

/**
 * Covers the alarm half of the attention panel (issue #201's "add something to
 * the attention stream"). Alarms have their own table rather than living in the
 * attention table, so the Ringing section is fed by the alarm store — this pins
 * that it lists every unhandled alarm and dismisses them one at a time.
 */

stubAlarmsApi();

let pending: AttentionItem[] = [];
const patched: { path: string; body: string }[] = [];
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

stubSidecarApi({
  sidecarFetch: async (path: string, init: RequestInit = {}) => {
    if (init.method === "PATCH") {
      patched.push({ path, body: String(init.body) });
      return json({});
    }
    return path.startsWith("/api/attention") ? json(pending) : json([]);
  },
  // Open until the store aborts it; these tests hydrate only.
  streamSSE: async function* (_path: string, init: RequestInit = {}) {
    await new Promise<void>((resolve) => init.signal?.addEventListener("abort", () => resolve()));
  },
});

const AttentionPanel = (await import("./AttentionPanel")).default;

const fired = (id: string, label: string): Alarm => ({
  id,
  label,
  fireAtMs: Date.now(),
  sound: true,
  meetLink: null,
  status: "fired",
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

let unmount: (() => void) | null = null;
let openedAlarms = 0;

afterEach(() => {
  unmount?.();
  unmount = null;
  openedAlarms = 0;
});

afterAll(() => {
  resetAlarms();
  resetSidecarApi();
});

async function mountPanel(): Promise<HTMLElement> {
  const mounted = await mountForInteraction(
    createElement(AttentionPanel, {
      open: true,
      onClose: () => {},
      onOpenAttention: () => {},
      wip: [],
      wipLoading: false,
      onOpenWip: () => {},
      onOpenAlarms: () => {
        openedAlarms += 1;
      },
    }),
    50,
  );
  unmount = mounted.unmount;
  return mounted.host;
}

describe("AttentionPanel ringing alarms", () => {
  it("lists every unhandled alarm and dismisses them one at a time", async () => {
    setAlarms([fired("att-a", "Morning coffee"), fired("att-b", "Retro")]);
    const host = await mountPanel();

    expect(host.innerHTML).toContain("Ringing");
    expect(host.innerHTML).toContain("Morning coffee");
    expect(host.innerHTML).toContain("Retro");

    const dismiss = Array.from(host.querySelectorAll("button")).filter(
      (b) => b.textContent === "Dismiss",
    );
    expect(dismiss).toHaveLength(2);

    dismiss[0]?.click();
    await settle();

    expect(host.innerHTML).not.toContain("Morning coffee");
    expect(host.innerHTML).toContain("Retro");
  });

  it("sends the user to the alarms page when a row is clicked", async () => {
    setAlarms([fired("att-open", "Standup")]);
    const host = await mountPanel();

    const row = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Standup"),
    );
    expect(row).toBeDefined();
    row?.click();
    await settle();

    expect(openedAlarms).toBe(1);
  });

  it("omits the ringing section entirely when nothing has fired", async () => {
    setAlarms([{ ...fired("quiet", "Later"), status: "scheduled" }]);
    const host = await mountPanel();

    expect(host.innerHTML).not.toContain("Ringing");
    expect(host.innerHTML).toContain("Needs you now");
  });
});

const attention = (overrides: Partial<AttentionItem> & { id: string; seq: number }) =>
  ({
    source: "system",
    sessionKey: null,
    workspaceId: null,
    kind: "action",
    category: "general",
    title: "Something",
    body: null,
    status: "pending",
    navTarget: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }) as AttentionItem;

describe("AttentionPanel needs-you-now stream", () => {
  afterEach(() => {
    pending = [];
    patched.length = 0;
    localStorage.removeItem("yarvis.attention.groupByCategory");
  });

  const text = (host: HTMLElement) => host.textContent ?? "";
  const button = (host: HTMLElement, label: string) =>
    Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.startsWith(label));

  it("groups items by category with review first, and filters to one", async () => {
    pending = [
      attention({ id: "b", seq: 2, category: "build", title: "CI is red" }),
      attention({ id: "r", seq: 1, category: "review", title: "Review Sam's PR" }),
    ];
    const host = await mountPanel();
    await waitFor(() => text(host).includes("CI is red"), "the items");

    const t = text(host);
    expect(t.indexOf("Review Sam's PR")).toBeLessThan(t.indexOf("CI is red"));
    expect(t).toContain("Build 1");

    button(host, "Build")?.click();
    await waitFor(() => !text(host).includes("Review Sam's PR"), "the filter");
    expect(text(host)).toContain("CI is red");
  });

  it("remembers turning grouping off", async () => {
    const host = await mountPanel();
    const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(toggle?.checked).toBe(true);
    toggle?.click();
    expect(localStorage.getItem("yarvis.attention.groupByCategory")).toBe("0");
  });

  it("shows a message whole and marks it read", async () => {
    pending = [
      attention({
        id: "m1",
        seq: 1,
        kind: "message",
        title: "Staging test passed",
        body: "All 42 checks passed.\nNothing to do.",
      }),
    ];
    const host = await mountPanel();
    await waitFor(() => text(host).includes("Staging test passed"), "the message");
    expect(host.innerHTML).toContain("whitespace-pre-wrap");

    button(host, "Mark read")?.click();
    await waitFor(() => patched.length > 0, "the read request");
    expect(patched[0]).toEqual({ path: "/api/attention/m1", body: '{"status":"read"}' });
    await waitFor(() => !text(host).includes("Staging test passed"), "the message to clear");
  });
});
