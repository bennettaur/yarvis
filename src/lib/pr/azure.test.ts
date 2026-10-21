import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as api from "../api";
import { azPrSummary } from "./azure";

const calls: string[] = [];

// A spy, not `mock.module`, so the stub doesn't outlive this file (see guide.test.ts).
const sidecarFetch = spyOn(api, "sidecarFetch").mockImplementation(async (path: string) => {
  calls.push(path);
  return new Response(
    JSON.stringify({
      prId: 7,
      title: "Fix bug",
      url: "https://dev.azure.com/acme/Shop%20App/_git/web/pullrequest/7",
      org: "acme",
      project: "Shop App",
      repo: "web",
      author: "Them",
      draft: false,
      status: "active",
      createdAt: "2026-06-01",
    }),
    { status: 200 },
  );
});

afterAll(() => {
  sidecarFetch.mockRestore();
});

describe("azPrSummary", () => {
  it("sends the link's org so the sidecar can refuse another org's PR", async () => {
    const summary = await azPrSummary({
      provider: "azure",
      org: "acme",
      project: "Shop App",
      repo: "web",
      prId: 7,
    });

    expect(calls[calls.length - 1]).toBe("/api/azure/pr/Shop%20App/web/7/summary?org=acme");
    expect(summary.ref).toEqual({
      provider: "azure",
      org: "acme",
      project: "Shop App",
      repo: "web",
      prId: 7,
    });
    expect(summary.title).toBe("Fix bug");
  });
});
