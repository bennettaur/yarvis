import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

/**
 * The voice routes against a real speech server.
 *
 * `routes.test.ts` covers the rejections, all of which answer before any
 * provider is reached. This file covers the other half: a custom provider
 * pointed at a local OpenAI-audio server, so a request actually crosses the
 * wire and comes back. That path is what the Voice tab depends on for a local
 * whisper/Kokoro setup, and the status split it produces (400 for what the user
 * typed, 502 for what the backend did) is what the UI branches on.
 */

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);

const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

const SPOKEN_AUDIO = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);

/** Requests the fake server saw, so tests can assert what was actually sent. */
interface SeenRequest {
  path: string;
  model: string | null;
  input: string | null;
}

/**
 * A minimal OpenAI-audio server. `mode` lets a test make it fail without
 * changing anything else about the wiring.
 */
function startSpeechServer(mode: "ok" | "error" = "ok") {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (mode === "error") {
        seen.push({ path, model: null, input: null });
        return new Response("upstream exploded", { status: 500 });
      }
      if (path === "/v1/audio/transcriptions") {
        const form = await req.formData();
        seen.push({ path, model: String(form.get("model")), input: null });
        return Response.json({ text: "  turn the build green  " });
      }
      if (path === "/v1/audio/speech") {
        const body = (await req.json()) as { model: string; input: string };
        seen.push({ path, model: body.model, input: body.input });
        return new Response(SPOKEN_AUDIO, { headers: { "Content-Type": "audio/wav" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, seen, baseUrl: `http://127.0.0.1:${server.port}/v1` };
}

/** Registers a custom provider through the real route and returns its voice id. */
async function registerProvider(baseUrl: string, apiKind = "openai"): Promise<string> {
  const res = await app.request("/api/custom-providers", {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify({
      name: "local speech",
      baseUrl,
      apiKind,
      models: ["whisper-1"],
      headerNames: [],
    }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  return `custom:${id}`;
}

function transcribeRequest(provider: string, model: string): Request {
  return new Request(
    `http://localhost/api/voice/transcribe?provider=${encodeURIComponent(provider)}&model=${model}`,
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "audio/webm" },
      body: new Uint8Array([1, 2, 3, 4]),
    },
  );
}

beforeEach(async () => {
  await sql`TRUNCATE custom_providers RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("voice round trip through a local speech server", () => {
  it("transcribes an utterance", async () => {
    const { server, seen, baseUrl } = startSpeechServer();
    try {
      const provider = await registerProvider(baseUrl);
      const res = await app.request(transcribeRequest(provider, "whisper-1"));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ text: "turn the build green" });
      expect(seen).toEqual([{ path: "/v1/audio/transcriptions", model: "whisper-1", input: null }]);
    } finally {
      server.stop(true);
    }
  });

  it("synthesizes speech and answers with the provider's audio", async () => {
    const { server, seen, baseUrl } = startSpeechServer();
    try {
      const provider = await registerProvider(baseUrl);
      const res = await app.request("/api/voice/speak", {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ provider, model: "kokoro", text: "the build is green" }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("audio/wav");
      // The provider's declared type is echoed only because it is an audio type.
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(SPOKEN_AUDIO);
      expect(seen[0]?.input).toBe("the build is green");
    } finally {
      server.stop(true);
    }
  });

  it("reports a backend failure as a bad gateway, not a bad request", async () => {
    const { server, baseUrl } = startSpeechServer("error");
    try {
      const provider = await registerProvider(baseUrl);
      const res = await app.request(transcribeRequest(provider, "whisper-1"));

      expect(res.status).toBe(502);
      expect(await res.text()).toContain("upstream exploded");
    } finally {
      server.stop(true);
    }
  });

  it("reports a mistyped model id as the user's to fix", async () => {
    const { server, seen, baseUrl } = startSpeechServer();
    try {
      const provider = await registerProvider(baseUrl);
      const res = await app.request(transcribeRequest(provider, "a%2F..%2F..%2Fadmin"));

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("invalid model id");
      // Refused before anything left the process.
      expect(seen).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  it("leaves an Anthropic-kind provider out of the speech list and refuses it", async () => {
    const { server, baseUrl } = startSpeechServer();
    try {
      const provider = await registerProvider(baseUrl, "anthropic");

      const list = await app.request("/api/voice/providers", { headers: auth });
      const providers = (await list.json()) as { id: string }[];
      expect(providers.map((p) => p.id)).not.toContain(provider);

      const res = await app.request(transcribeRequest(provider, "whisper-1"));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("does not speak the OpenAI audio API");
    } finally {
      server.stop(true);
    }
  });

  it("lists a configured speech provider alongside the built-in", async () => {
    const { server, baseUrl } = startSpeechServer();
    try {
      const provider = await registerProvider(baseUrl);
      const res = await app.request("/api/voice/providers", { headers: auth });
      const providers = (await res.json()) as { id: string; custom?: boolean }[];

      expect(providers.map((p) => p.id)).toContain("huggingface");
      expect(providers.find((p) => p.id === provider)?.custom).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
