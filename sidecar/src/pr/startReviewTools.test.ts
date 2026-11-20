import { describe, expect, it } from "bun:test";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { buildPrReviewStartTools } from "./startReviewTools.ts";

// Every case here is refused before the database or a provider is reached.
const config = { secrets: {} } as unknown as Config;
const tools = buildPrReviewStartTools(undefined as unknown as Db, config);

async function run(name: keyof typeof tools, input: unknown) {
  const t = tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> };
  return t.execute(input, { toolCallId: "t", messages: [] });
}

describe("PR review start tools", () => {
  it("refuses an Azure PR when no organization is configured", async () => {
    const pullRequest = { provider: "azure", project: "p", repo: "r", prId: 3 };
    for (const name of ["start_pr_guided_review", "start_pr_verification_report"] as const) {
      expect(await run(name, { pullRequest })).toEqual({
        error: "Azure DevOps isn't configured in Settings → Credentials.",
      });
    }
  });

  it("says when GitHub isn't signed in", async () => {
    const pullRequest = { provider: "github", owner: "o", repo: "r", number: 1 };
    expect(await run("start_pr_guided_review", { pullRequest })).toEqual({
      status: "error",
      error: "github token not configured",
    });
  });

  it("takes a list or a stack for a queue, not both or neither", async () => {
    const pullRequest = { provider: "github", owner: "o", repo: "r", number: 1 };
    const refused = { status: "error", error: "Give either pullRequests or stackOf." };
    expect(await run("start_pr_verification_queue", {})).toEqual(refused);
    expect(
      await run("start_pr_verification_queue", {
        pullRequests: [pullRequest],
        stackOf: pullRequest,
      }),
    ).toEqual(refused);
  });

  it("says why a stack can't be queued", async () => {
    const stackOf = { provider: "github" as const, owner: "o", repo: "r", number: 1 };
    expect(await run("start_pr_verification_queue", { stackOf })).toEqual({
      status: "error",
      error: "GitHub isn't signed in under Settings → Credentials.",
    });
    const stacked = (count: number) =>
      buildPrReviewStartTools(undefined as unknown as Db, config, {
        loadStack: async () =>
          Array.from({ length: count }, (_, i) => ({ ...stackOf, number: i + 1 })),
      }).start_pr_verification_queue as unknown as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      };
    const opts = { toolCallId: "t", messages: [] };
    expect(await stacked(0).execute({ stackOf }, opts)).toEqual({
      status: "error",
      error: "The stack has no open PRs.",
    });
    expect(await stacked(11).execute({ stackOf }, opts)).toMatchObject({
      status: "error",
      error: expect.stringContaining("The stack has 11 open PRs"),
    });
  });

  it("says when a queue it was asked about isn't known", async () => {
    expect(
      await run("check_pr_verification_queue", { queueId: "00000000-0000-4000-8000-000000000000" }),
    ).toEqual({ status: "error", error: "No such queue; it may predate a restart." });
  });
});
