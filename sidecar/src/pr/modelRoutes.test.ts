import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

/** No database URL: the setting must work without Postgres, unlike `/api/pr`. */
function app(): ReturnType<typeof createApp> {
  return createApp({
    port: 0,
    token: "test-token",
    tokenGenerated: false,
    attentionToken: "test-attention-token",
    mcpToken: "test-mcp-token",
    allowedOrigins: null,
    databaseUrl: undefined,
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets: {},
    customProviderSecrets: {},
    mcpSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  } satisfies Config);
}

const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

let settingsDir: string;
let originalSettingsPath: string | undefined;

beforeEach(async () => {
  settingsDir = await mkdtemp(join(tmpdir(), "yarvis-pr-model-routes-"));
  originalSettingsPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
});

afterEach(async () => {
  if (originalSettingsPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalSettingsPath;
  await rm(settingsDir, { recursive: true, force: true });
});

describe("GET/PATCH /api/pr-models", () => {
  it("requires the bearer token", async () => {
    expect((await app().request("/api/pr-models")).status).toBe(401);
  });

  it("saves and reads a feature back", async () => {
    const res = await app().request("/api/pr-models", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ guide: { provider: "anthropic", model: "claude-opus-5-5" } }),
    });
    expect(res.status).toBe(200);

    const read = await app().request("/api/pr-models", { headers: auth });
    expect(await read.json()).toEqual({
      guide: { provider: "anthropic", model: "claude-opus-5-5" },
      ask: null,
    });
  });

  it("rejects a model id shaped like a path traversal", async () => {
    const res = await app().request("/api/pr-models", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ ask: { provider: "gemini", model: "../../v1beta/other" } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET/PATCH /api/pr-models/verification", () => {
  const patch = (body: unknown) =>
    app().request("/api/pr-models/verification", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify(body),
    });

  it("answers the defaults before anything is saved, with each section's own", async () => {
    const res = await app().request("/api/pr-models/verification", { headers: auth });
    const body = (await res.json()) as { sectionDefaults: unknown[] };
    expect(body).toMatchObject({ maxBudgetUsd: 2, sections: {} });
    expect(body.sectionDefaults).toContainEqual({
      section: "malice",
      label: "Malicious intent",
      model: "opus",
      effort: "high",
    });
  });

  it("saves one field and keeps the other", async () => {
    expect(await (await patch({ maxBudgetUsd: 0.75 })).json()).toMatchObject({
      maxBudgetUsd: 0.75,
      sections: {},
    });
    await patch({ sections: { risk: { model: "sonnet" } } });
    await patch({ sections: { comments: { effort: "high" } } });
    const read = await app().request("/api/pr-models/verification", { headers: auth });
    expect(await read.json()).toMatchObject({
      maxBudgetUsd: 0.75,
      sections: { risk: { model: "sonnet" }, comments: { effort: "high" } },
    });
  });

  it("puts a section back on its default when its override is emptied", async () => {
    await patch({ sections: { risk: { model: "haiku", effort: "low" } } });
    const cleared = (await (await patch({ sections: { risk: {} } })).json()) as {
      sections: unknown;
    };
    expect(cleared.sections).toEqual({});
  });

  it("replaces a section's override whole, rather than merging into it", async () => {
    await patch({ sections: { risk: { model: "haiku", effort: "low" } } });
    const saved = (await (await patch({ sections: { risk: { effort: "high" } } })).json()) as {
      sections: unknown;
    };
    expect(saved.sections).toEqual({ risk: { effort: "high" } });
  });

  it("reads hand-edited or older settings leniently, keeping what still validates", async () => {
    await writeFile(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        prVerification: {
          model: "opus",
          maxBudgetUsd: 3,
          sections: {
            risk: { model: "gpt-4" },
            comments: { effort: "high" },
            malice: { model: "opus", effort: "extreme" },
          },
        },
      }),
    );
    const read = await app().request("/api/pr-models/verification", { headers: auth });
    const body = (await read.json()) as Record<string, unknown>;
    // The single model from before each check had its own is gone.
    expect(body.model).toBeUndefined();
    expect(body).toMatchObject({ maxBudgetUsd: 3 });
    expect(body.sections).toEqual({ comments: { effort: "high" }, malice: { model: "opus" } });

    await writeFile(
      join(settingsDir, "settings.json"),
      JSON.stringify({ prVerification: { sections: "x" } }),
    );
    const odd = await app().request("/api/pr-models/verification", { headers: auth });
    expect(((await odd.json()) as { sections: unknown }).sections).toEqual({});
  });

  it("takes a budget of any size, since it only warns", async () => {
    expect(await (await patch({ maxBudgetUsd: 500 })).json()).toMatchObject({ maxBudgetUsd: 500 });
  });

  it("refuses unknown models, efforts and sections, and a budget below the minimum", async () => {
    for (const body of [
      { sections: { risk: { model: "--model=x" } } },
      { sections: { risk: { effort: "extreme" } } },
      { sections: { nope: { model: "haiku" } } },
      { sections: { risk: { model: "haiku", other: 1 } } },
      { model: "opus" },
      { maxBudgetUsd: 0 },
      { other: 1 },
    ]) {
      expect((await patch(body)).status).toBe(400);
    }
  });
});

describe("GET/PATCH /api/pr-models/rereview", () => {
  const patch = (body: unknown) =>
    app().request("/api/pr-models/rereview", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify(body),
    });
  const read = async () =>
    (await app().request("/api/pr-models/rereview", { headers: auth })).json();

  it("answers its own defaults, off until turned on, apart from the verification report's", async () => {
    expect(await read()).toEqual({ model: "sonnet", maxBudgetUsd: 1, autoStart: false });
    await patch({ autoStart: true, maxBudgetUsd: 0.5 });
    await patch({ model: "haiku" });
    expect(await read()).toEqual({ model: "haiku", maxBudgetUsd: 0.5, autoStart: true });
    const verification = await app().request("/api/pr-models/verification", { headers: auth });
    expect(await verification.json()).toMatchObject({ maxBudgetUsd: 2, sections: {} });
  });

  it("takes a budget of any size", async () => {
    expect(await (await patch({ maxBudgetUsd: 500 })).json()).toMatchObject({ maxBudgetUsd: 500 });
  });

  it("refuses values it doesn't know", async () => {
    for (const body of [{ autoStart: "yes" }, { maxBudgetUsd: 0.1 }, { model: "gpt" }, { x: 1 }]) {
      expect((await patch(body)).status).toBe(400);
    }
  });
});
