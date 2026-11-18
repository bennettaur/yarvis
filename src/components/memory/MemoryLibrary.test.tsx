import { afterAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToHtml, textOf } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";

const BASE = {
  kind: "fact",
  sourceRef: null,
  metadata: null,
  createdAt: "2026-10-08T10:00:00.000Z",
  supersededAt: null,
  validFrom: "2026-10-08T10:00:00.000Z",
  confirmedAt: "2026-10-08T10:00:00.000Z",
  confirmCount: 0,
};

const MEMORIES = [
  {
    ...BASE,
    id: "m1",
    content: "GitHub is down",
    validUntil: "2026-10-08T11:00:00.000Z",
    validity: "expired",
  },
  {
    ...BASE,
    id: "m2",
    content: "The user is on vacation",
    validFrom: "2026-10-20T00:00:00.000Z",
    validUntil: null,
    validity: "upcoming",
  },
  {
    ...BASE,
    id: "m3",
    content: "The deploy freeze holds",
    validUntil: "2099-01-01T00:00:00.000Z",
    validity: "current",
  },
  {
    ...BASE,
    id: "m4",
    content: "The user prefers dark mode",
    validUntil: null,
    validity: "current",
  },
];

stubSidecarApi({
  getHealth: async () => ({
    status: "ok",
    service: "sidecar",
    uptimeMs: 0,
    ready: true,
    phase: "ready" as const,
  }),
  waitForSidecarReady: async () => {},
  getStatus: async () => ({
    service: "sidecar",
    databaseConfigured: true,
    providers: { anthropic: false, gemini: false, cerebras: false, huggingface: false },
  }),
  getDbHealth: async () => ({ configured: true, reachable: true }),
  streamSSE: async function* streamSSE() {},
  sidecarFetch: async () =>
    new Response(
      JSON.stringify({ items: MEMORIES, total: MEMORIES.length, limit: 50, offset: 0 }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ),
});

const MemoryLibrary = (await import("./MemoryLibrary")).default;

/** The rendered line for one memory, from its content to the next memory's. */
function lineFor(text: string, content: string): string {
  const from = text.indexOf(content);
  const next = MEMORIES.map((m) => text.indexOf(m.content, from + content.length))
    .filter((i) => i > from)
    .sort((a, b) => a - b)[0];
  return text.slice(from, next);
}

describe("MemoryLibrary", () => {
  it("marks an expired memory and says when it expired", async () => {
    const text = textOf(await renderToHtml(createElement(MemoryLibrary)));
    expect(text).toContain("expired");
    expect(lineFor(text, "GitHub is down")).toContain("· expired ");
  });

  it("marks an upcoming memory and says when it starts", async () => {
    const text = textOf(await renderToHtml(createElement(MemoryLibrary)));
    expect(text).toContain("upcoming");
    expect(lineFor(text, "The user is on vacation")).toContain("· from ");
  });

  it("shows when a current memory with a window ends, and nothing for an open-ended one", async () => {
    const text = textOf(await renderToHtml(createElement(MemoryLibrary)));
    expect(lineFor(text, "The deploy freeze holds")).toContain("· until ");
    const openEnded = lineFor(text, "The user prefers dark mode");
    expect(openEnded).not.toContain("until");
    expect(openEnded).not.toContain("expired");
  });
});

afterAll(resetSidecarApi);
