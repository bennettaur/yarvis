import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import type { Config } from "../config.ts";
import { createCustomProvider } from "../customProviders/service.ts";
import { CUSTOM_PROVIDER_PREFIX, resolveModel } from "./providers.ts";
import { fillMissingReasoningSummaries } from "./responsesCompat.ts";

/** A non-streamed reply shaped like LiteLLM's for a Bedrock Claude: the reasoning item has no `summary`. */
function litellmReply(output: unknown[]): Record<string, unknown> {
  return {
    id: "resp_1",
    created_at: 1792596378,
    error: null,
    incomplete_details: null,
    model: "bedrock-claude-opus-5-5",
    object: "response",
    output,
    status: "completed",
    text: {},
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

const reasoningItem = {
  type: "reasoning",
  id: "rs_1",
  status: "completed",
  role: "assistant",
  content: [],
  encrypted_content: '[{"type":"thinking","thinking":"","signature":"sig"}]',
};

function messageItem(text: string) {
  return {
    type: "message",
    id: "msg_1",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

let settingsDir: string;
let originalSettingsPath: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(async () => {
  settingsDir = await mkdtemp(join(tmpdir(), "yarvis-responses-compat-"));
  originalSettingsPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
});

afterEach(async () => {
  server?.stop(true);
  server = undefined;
  if (originalSettingsPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalSettingsPath;
  await rm(settingsDir, { recursive: true, force: true });
});

/** Serves `replies` in order and records each request body. */
async function fakeGateway(replies: Record<string, unknown>[]) {
  const requests: Record<string, unknown>[] = [];
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      requests.push((await req.json()) as Record<string, unknown>);
      return Response.json(replies[requests.length - 1]);
    },
  });
  const row = await createCustomProvider({
    name: "litellm",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    apiKind: "openai",
    models: ["bedrock-claude-opus-5-5"],
    headerNames: [],
  });
  const config = {
    secrets: {},
    customProviderSecrets: { [row.id]: { apiKey: "sk-fake", headers: {} } },
  } as unknown as Config;
  const model = await resolveModel(
    config,
    `${CUSTOM_PROVIDER_PREFIX}${row.id}`,
    "bedrock-claude-opus-5-5",
  );
  return { model, requests };
}

describe("a custom Responses provider behind LiteLLM", () => {
  it("accepts a reasoning item with no summary", async () => {
    const { model } = await fakeGateway([litellmReply([reasoningItem, messageItem("Done.")])]);
    const result = await generateText({ model, prompt: "Summarize my week." });
    expect(result.text).toBe("Done.");
  });

  it("replays reasoning inline on the next step instead of by id", async () => {
    const { model, requests } = await fakeGateway([
      litellmReply([
        reasoningItem,
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "lookup",
          arguments: "{}",
          status: "completed",
        },
      ]),
      litellmReply([messageItem("Found it.")]),
    ]);
    const result = await generateText({
      model,
      prompt: "Look it up.",
      tools: { lookup: tool({ inputSchema: z.object({}), execute: async () => "ok" }) },
      stopWhen: stepCountIs(3),
    });

    expect(result.text).toBe("Found it.");
    expect(requests[0]?.store).toBe(false);
    const replayed = requests[1]?.input as { type: string; encrypted_content?: string }[];
    expect(replayed.some((item) => item.type === "item_reference")).toBe(false);
    expect(replayed.find((item) => item.type === "reasoning")?.encrypted_content).toBe(
      reasoningItem.encrypted_content,
    );
  });
});

describe("fillMissingReasoningSummaries", () => {
  it("keeps a summary the gateway did send", async () => {
    const summary = [{ type: "summary_text", text: "thought" }];
    const res = await fillMissingReasoningSummaries(
      Response.json(litellmReply([{ ...reasoningItem, summary }])),
    );
    expect(((await res.json()) as { output: { summary: unknown }[] }).output[0]?.summary).toEqual(
      summary,
    );
  });

  it("passes an error body that isn't JSON through unchanged", async () => {
    const res = await fillMissingReasoningSummaries(
      new Response("upstream timeout", {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("upstream timeout");
  });

  it("leaves a streamed reply alone", async () => {
    const original = new Response("data: {}\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    expect(await fillMissingReasoningSummaries(original)).toBe(original);
  });
});
