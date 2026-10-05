/**
 * A stand-in chat model that speaks the OpenAI chat-completions API, so the
 * sidecar can use it as an ordinary custom provider. It answers from the
 * canned replies in `script.ts`, streamed a few characters at a time so a
 * recording shows the reply being written.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type CannedReply, DEFAULT_REPLY, OMNI_DEFAULT_REPLY, REPLIES } from "./script";

export const FAKE_MODEL = "demo-model";

/** How fast a streamed reply comes out, in milliseconds. */
export interface Pacing {
  firstToken: number;
  /** Between chat chunks of `CHUNK_CHARS` characters. */
  chunk: number;
  /** Between lines of an Omni layout, so the canvas fills in piece by piece. */
  omniLine: number;
}

/** Fast enough to keep flows short, slow enough to read on video. */
const RECORDING_PACE: Pacing = { firstToken: 500, chunk: 18, omniLine: 120 };
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

/** Omni's builder sends json-render's generator prompt as its system message. */
function isOmniBuilder(request: ChatRequest): boolean {
  const system = request.messages.find((m) => m.role === "system" || m.role === "developer");
  return system !== undefined && textOf(system).startsWith("You are a UI generator");
}

/** The user's own words, skipping the screen snapshot Omni Chat sends alongside them. */
function lastUserText(request: ChatRequest): string {
  const users = request.messages.filter(
    (m) => m.role === "user" && !textOf(m).trimStart().startsWith("<screen-context"),
  );
  return users.length > 0 ? textOf(users[users.length - 1]) : "";
}

function pickReply(request: ChatRequest): CannedReply {
  const omni = isOmniBuilder(request);
  const said = lastUserText(request);
  const match = REPLIES.find((r) => (r.surface === "omni") === omni && r.when.test(said));
  return match ?? (omni ? OMNI_DEFAULT_REPLY : DEFAULT_REPLY);
}

type Step =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown> };

/**
 * What to send for this request. A reply with a tool call takes two requests:
 * the first returns the call, and the second, which carries the tool's result,
 * returns the text written after it.
 */
function nextStep(request: ChatRequest): Step {
  const reply = pickReply(request);
  const last = request.messages[request.messages.length - 1];
  if (reply.toolCall && last?.role !== "tool") {
    const offered = request.tools?.map((t) => t.function.name) ?? [];
    if (!offered.includes(reply.toolCall.name)) {
      console.warn(
        `[fake-llm] "${reply.toolCall.name}" isn't among the tools offered (${offered.join(", ")}); replying with text`,
      );
      return { kind: "text", text: reply.after ?? reply.text ?? "" };
    }
    return { kind: "tool", ...reply.toolCall };
  }
  return { kind: "text", text: reply.toolCall ? (reply.after ?? "") : (reply.text ?? "") };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Splits text into the pieces it streams as: lines for Omni, small runs of characters otherwise. */
function pieces(text: string, omni: boolean, pace: Pacing): { piece: string; delayMs: number }[] {
  if (omni) {
    return text.split(/(?<=\n)/).map((piece) => ({ piece, delayMs: pace.omniLine }));
  }
  const out: { piece: string; delayMs: number }[] = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) {
    out.push({ piece: text.slice(i, i + CHUNK_CHARS), delayMs: pace.chunk });
  }
  return out;
}

let callCount = 0;

async function stream(res: ServerResponse, step: Step, omni: boolean, pace: Pacing): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const id = `chatcmpl-demo-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const send = (delta: object, finishReason: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: FAKE_MODEL,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );

  await sleep(pace.firstToken);
  if (step.kind === "tool") {
    callCount += 1;
    send({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `call_demo_${callCount}`,
          type: "function",
          function: { name: step.name, arguments: JSON.stringify(step.args) },
        },
      ],
    });
    send({}, "tool_calls");
  } else {
    send({ role: "assistant", content: "" });
    for (const { piece, delayMs } of pieces(step.text, omni, pace)) {
      send({ content: piece });
      await sleep(delayMs);
    }
    send({}, "stop");
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function respondOnce(res: ServerResponse, step: Step): void {
  const message =
    step.kind === "tool"
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_demo_${++callCount}`,
              type: "function",
              function: { name: step.name, arguments: JSON.stringify(step.args) },
            },
          ],
        }
      : { role: "assistant", content: step.text };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: `chatcmpl-demo-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: FAKE_MODEL,
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

async function handle(req: IncomingMessage, res: ServerResponse, pace: Pacing): Promise<void> {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  const request = JSON.parse(await readBody(req)) as ChatRequest;
  const step = nextStep(request);
  if (request.stream) await stream(res, step, isOmniBuilder(request), pace);
  else respondOnce(res, step);
}

/** Starts the fake model on `port` and resolves once it's listening. */
export function startFakeLlm(port: number, pace: Pacing = RECORDING_PACE): Promise<Server> {
  const server = createServer((req, res) => {
    handle(req, res, pace).catch((e) => {
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
