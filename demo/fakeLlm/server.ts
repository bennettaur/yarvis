/**
 * A stand-in chat model that speaks the OpenAI chat-completions API, so the
 * sidecar can use it as an ordinary custom provider. It answers from the
 * canned replies in `script.ts`, streamed a few characters at a time so a
 * recording shows the reply being written.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DEFAULT_REPLY, OMNI_DEFAULT_REPLY, REPLIES, type Reply, SAFE_TOOLS } from "./script";

export const FAKE_MODEL = "demo-model";

/** How fast a streamed reply comes out. */
export interface Pacing {
  /** Before anything is sent, like a real model's time to first token. */
  firstTokenMs: number;
  /** Between chat chunks of `CHUNK_CHARS` characters. */
  chunkMs: number;
  /** Between lines of an Omni layout, so the canvas fills in piece by piece. */
  omniLineMs: number;
}

/** Fast enough to keep flows short, slow enough to read on video. */
const RECORDING_PACE: Pacing = { firstTokenMs: 500, chunkMs: 18, omniLineMs: 120 };
const CHUNK_CHARS = 4;

interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | { type: string; text?: string }[] | null;
}

interface ChatRequest {
  messages: ChatMessage[];
  stream?: boolean;
  tools?: { function: { name: string } }[];
}

function textOf(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).map((part) => part.text ?? "").join("");
}

/**
 * Omni's builder sends json-render's generator prompt as its system message,
 * which asks for patches in a ```spec block. Chat's system prompt never does.
 */
function isOmniBuilder(request: ChatRequest): boolean {
  const system = request.messages.find((m) => m.role === "system" || m.role === "developer");
  return system !== undefined && textOf(system).includes("```spec");
}

/**
 * The user's latest message. Omni Chat's screen snapshot is also a user
 * message, but the sidecar sends it before the user's, so it's never last.
 */
function latestUserText(request: ChatRequest): string {
  const users = request.messages.filter((m) => m.role === "user");
  return users.length > 0 ? textOf(users[users.length - 1]) : "";
}

function pickReply(request: ChatRequest, isOmni: boolean): Reply {
  const userText = latestUserText(request);
  const match = REPLIES.find((r) => (r.surface === "omni") === isOmni && r.when.test(userText));
  return match ?? (isOmni ? OMNI_DEFAULT_REPLY : DEFAULT_REPLY);
}

type Step =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown> };

/**
 * What to send for this request. A reply with a tool call takes two requests:
 * the first returns the call, and the second, which carries the tool's result,
 * returns the text written after it.
 */
function nextStep(request: ChatRequest, isOmni: boolean): Step {
  const reply = pickReply(request, isOmni);
  if (!("toolCall" in reply)) return { kind: "text", text: reply.text };

  const toolHasRun = request.messages[request.messages.length - 1]?.role === "tool";
  if (toolHasRun) return { kind: "text", text: reply.after };

  const { name } = reply.toolCall;
  const offered = request.tools?.map((t) => t.function.name) ?? [];
  if (!SAFE_TOOLS.has(name) || !offered.includes(name)) {
    console.warn(
      `[fake-llm] not calling "${name}": it isn't in SAFE_TOOLS or wasn't offered (${offered.join(", ")}); replying with text`,
    );
    return { kind: "text", text: reply.after };
  }
  return { kind: "tool", ...reply.toolCall };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Splits text into the chunks it streams as: lines for Omni, small runs of characters otherwise. */
function splitForStreaming(text: string, isOmni: boolean, pace: Pacing) {
  if (isOmni) {
    return text.split(/(?<=\n)/).map((chunk) => ({ chunk, delayMs: pace.omniLineMs }));
  }
  const chunks: { chunk: string; delayMs: number }[] = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) {
    chunks.push({ chunk: text.slice(i, i + CHUNK_CHARS), delayMs: pace.chunkMs });
  }
  return chunks;
}

let toolCallCount = 0;

function toolCallFor(step: Extract<Step, { kind: "tool" }>) {
  toolCallCount += 1;
  return {
    id: `call_demo_${toolCallCount}`,
    type: "function",
    function: { name: step.name, arguments: JSON.stringify(step.args) },
  };
}

function envelope() {
  return {
    id: `chatcmpl-demo-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model: FAKE_MODEL,
  };
}

async function respondStreaming(
  res: ServerResponse,
  step: Step,
  isOmni: boolean,
  pace: Pacing,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const base = { ...envelope(), object: "chat.completion.chunk" };
  const send = (delta: object, finishReason: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
    );

  await sleep(pace.firstTokenMs);
  if (step.kind === "tool") {
    send({ role: "assistant", tool_calls: [{ index: 0, ...toolCallFor(step) }] });
    send({}, "tool_calls");
  } else {
    send({ role: "assistant", content: "" });
    for (const { chunk, delayMs } of splitForStreaming(step.text, isOmni, pace)) {
      // The sidecar hung up, e.g. the user stopped the turn.
      if (res.destroyed) return;
      send({ content: chunk });
      await sleep(delayMs);
    }
    send({}, "stop");
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function respondWhole(res: ServerResponse, step: Step): void {
  const message =
    step.kind === "tool"
      ? { role: "assistant", content: null, tool_calls: [toolCallFor(step)] }
      : { role: "assistant", content: step.text };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ...envelope(),
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: step.kind === "tool" ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  );
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, pace: Pacing) {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  const request = JSON.parse(await readBody(req)) as ChatRequest;
  const isOmni = isOmniBuilder(request);
  const step = nextStep(request, isOmni);
  if (request.stream) await respondStreaming(res, step, isOmni, pace);
  else respondWhole(res, step);
}

/** Starts the fake model on `port` and resolves once it's listening. */
export function startFakeLlm(port: number, pace: Pacing = RECORDING_PACE): Promise<Server> {
  const server = createServer((req, res) => {
    handleRequest(req, res, pace).catch((e) => {
      console.error("[fake-llm]", e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
