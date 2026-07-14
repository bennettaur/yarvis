import { describe, expect, it, mock } from "bun:test";
import type { ProvisionEvent } from "../../lib/workspaces";
import * as workspaces from "../../lib/workspaces";

// `consumeProvision` drives `provisionWorkspace()`; override just that export
// with a generator yielding a scripted event sequence so we can assert how each
// provision outcome is surfaced. The real module's other exports are spread
// back in — `mock.module` replaces the whole module process-wide, so dropping
// them would break unrelated tests that import them.
let scripted: ProvisionEvent[] = [];
mock.module("../../lib/workspaces", () => ({
  ...workspaces,
  async *provisionWorkspace() {
    for (const ev of scripted) yield ev;
  },
}));

const { consumeProvision } = await import("./provisionStream");

describe("consumeProvision", () => {
  it("returns a hard top-level error so the caller can show it inline", async () => {
    scripted = [{ type: "error", message: "workspace not found" }];
    const result = await consumeProvision("ws1", () => {});
    expect(result.error).toBe("workspace not found");
  });

  // The regression this guards: a repo whose setup script exits non-zero ends
  // the stream with repo-error + done{status:"error"}, NOT a top-level error.
  // It must resolve without an error so the caller lands on the detail view
  // (which surfaces the setup log) instead of collapsing to an error page.
  it("does not report a failed setup script as a top-level error", async () => {
    scripted = [
      { type: "repo-start", workspaceRepoId: "wr1", repo: "acme-web" },
      { type: "log", workspaceRepoId: "wr1", text: "$ bun install\n" },
      { type: "repo-error", workspaceRepoId: "wr1", message: "setup script exited 1" },
      { type: "done", status: "error" },
    ];
    const lines: string[] = [];
    const result = await consumeProvision("ws1", (t) => lines.push(t));
    expect(result.error).toBeUndefined();
    // The setup output still streamed through onLine for the live view.
    expect(lines.join("")).toContain("$ bun install");
  });

  it("resolves without an error on a clean finish", async () => {
    scripted = [
      { type: "repo-done", workspaceRepoId: "wr1", status: "ready", exitCode: 0 },
      { type: "done", status: "active" },
    ];
    const result = await consumeProvision("ws1", () => {});
    expect(result.error).toBeUndefined();
  });
});
