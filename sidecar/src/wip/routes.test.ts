import { describe, expect, it } from "bun:test";
import type { Config } from "../config.ts";
import { createWipRoutes } from "./routes.ts";

function config(databaseUrl: string | undefined): Config {
  return {
    port: 0,
    token: "test-token",
    tokenGenerated: false,
    attentionToken: "test-attention-token",
    allowedOrigins: null,
    databaseUrl,
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets: {},
    customProviderSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  };
}

describe("wip routes", () => {
  it("returns 503 when no database is configured", async () => {
    const app = createWipRoutes(config(undefined));
    const res = await app.request("/");
    expect(res.status).toBe(503);
  });
});
