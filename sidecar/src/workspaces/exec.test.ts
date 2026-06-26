import { describe, expect, it } from "bun:test";
import { scrubbedEnv } from "./exec.ts";

describe("scrubbedEnv", () => {
  it("strips provider secrets but keeps allowlisted vars", () => {
    // These are not in the allowlist, so they must never reach spawned scripts.
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    process.env.GITHUB_TOKEN = "ghp_secret";
    const env = scrubbedEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH ?? "");
  });

  it("overlays explicit extras on top of the allowlist", () => {
    const env = scrubbedEnv({ GIT_TERMINAL_PROMPT: "0" });
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});
