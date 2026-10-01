import { describe, expect, it } from "bun:test";
import type { Config } from "../config.ts";
import { buildHelpTools } from "./tools.ts";

// The AI SDK passes a second options argument to execute; tests don't need it.
const opts = { toolCallId: "test", messages: [] } as never;

function config(secrets: Config["secrets"], extra: Partial<Config> = {}): Config {
  return {
    databaseUrl: undefined,
    secrets,
    customProviderSecrets: {},
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
    ...extra,
  } as Config;
}

async function status(cfg: Config) {
  return (await buildHelpTools(cfg).yarvis_setup_status.execute!({} as never, opts)) as Record<
    string,
    unknown
  >;
}

describe("yarvis_setup_status", () => {
  it("reports what is configured without any secret value", async () => {
    const secrets = {
      anthropicApiKey: "sk-ant-SENTINEL",
      githubToken: "ghp_SENTINEL",
      jiraApiToken: "jira-SENTINEL",
      jiraBaseUrl: "https://x.atlassian.net",
      jiraEmail: "me@example.test",
      googleClientId: "id-SENTINEL",
      googleClientSecret: "GOCSPX-SENTINEL",
    };
    const result = await status(
      config(secrets, {
        databaseUrl: "postgres://user:pw-SENTINEL@localhost/yarvis",
        telegram: { botToken: "bot-SENTINEL", allowedChatIds: [], otpWindowMinutes: 120 },
      }),
    );

    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    expect(JSON.stringify(result)).not.toContain("me@example.test");
    expect(result).toMatchObject({
      database: true,
      github: true,
      jira: true,
      googleCalendarClient: true,
      telegram: true,
    });
  });

  it("needs both the token and the org URL for Azure DevOps", async () => {
    expect((await status(config({ azureDevopsToken: "t" }))).azureDevops).toBe(false);
    expect(
      (
        await status(
          config({ azureDevopsToken: "t", azureDevopsOrgUrl: "https://dev.azure.com/o" }),
        )
      ).azureDevops,
    ).toBe(true);
  });

  it("needs the token, base URL and email for JIRA", async () => {
    const partial = { jiraApiToken: "t", jiraBaseUrl: "https://x.atlassian.net" };
    expect((await status(config(partial))).jira).toBe(false);
  });

  it("says Bedrock's availability is unchecked", async () => {
    const providers = (await status(config({}))).chatProviders as Array<{
      id: string;
      note?: string;
    }>;
    expect(providers.find((p) => p.id === "bedrock")?.note).toContain("not checked");
  });
});

describe("read_yarvis_doc", () => {
  it("names the real pages when asked for one that doesn't exist", async () => {
    const result = (await buildHelpTools(config({})).read_yarvis_doc.execute!(
      { doc: "constructor" } as never,
      opts,
    )) as { error?: string; pages?: string[] };
    expect(result.error).toContain("No page named");
    expect(result.pages).toContain("configuration");
  });
});
