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
});
