import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToHtml, textOf } from "../../test/render";

const EVENTS = [
  {
    id: "e1",
    type: "pr.approved",
    source: "github",
    payload: { ref: "gh:me/app/12" },
    occurredAt: "2026-08-24T14:00:00.000Z",
    processedAt: null,
    createdAt: "2026-08-24T14:00:00.000Z",
  },
  {
    id: "e2",
    type: "workspace.archived",
    source: "workspaces",
    payload: { name: "events consolidation" },
    occurredAt: "2026-08-24T13:00:00.000Z",
    processedAt: "2026-08-24T16:00:00.000Z",
    createdAt: "2026-08-24T13:00:00.000Z",
  },
];

/** Records the query strings the tab asks for, so paging can be asserted. */
const requested: string[] = [];

mock.module("../../lib/api", () => ({
  sidecarFetch: async (path: string) => {
    requested.push(path);
    const body = path.includes("/api/events/types")
      ? { types: ["pr.approved", "pr.viewed", "workspace.archived", "task.created"] }
      : { items: EVENTS, total: 120, limit: 50, offset: 0 };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
}));

const EventsTab = (await import("./EventsTab")).default;

describe("EventsTab", () => {
  it("lists events with their type, source and payload", async () => {
    const text = textOf(await renderToHtml(createElement(EventsTab)));
    expect(text).toContain("pr.approved");
    expect(text).toContain("github");
    expect(text).toContain("gh:me/app/12");
    expect(text).toContain("workspace.archived");
  });

  it("reports the page position out of the full total", async () => {
    const text = textOf(await renderToHtml(createElement(EventsTab)));
    expect(text).toContain("of 120");
  });

  it("marks an event the consolidation job has not folded in yet", async () => {
    const html = await renderToHtml(createElement(EventsTab));
    // Exactly one of the two fixtures is unprocessed.
    expect(html.match(/>new</g)).toHaveLength(1);
  });

  it("offers a filter per event domain rather than per type", async () => {
    const html = await renderToHtml(createElement(EventsTab));
    for (const domain of ["pr", "workspace", "task"]) {
      expect(html).toContain(`value="${domain}"`);
    }
    // Domains, not the four raw types.
    expect(html).not.toContain('value="pr.approved"');
  });

  it("asks for a bounded page", async () => {
    requested.length = 0;
    await renderToHtml(createElement(EventsTab));
    expect(requested.some((path) => path.includes("limit=50&offset=0"))).toBe(true);
  });
});
