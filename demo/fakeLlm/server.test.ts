import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startFakeLlm } from "./server";

let server: Server;
let url: string;

beforeAll(async () => {
  server = await startFakeLlm(0, { firstToken: 0, chunk: 0, omniLine: 0 });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
});

afterAll(() => {
  server.close();
});

const CREATE_TASK_TOOL = [{ type: "function", function: { name: "create_task" } }];

/**
 * POSTs `body` and returns the response text. Uses node:http because the test
 * preload swaps `fetch` for happy-dom's, which refuses cross-origin requests.
 */
function complete(body: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST" }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => resolve(text));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

/** Streams a request and returns the concatenated text and any tool call. */
async function streamed(body: object) {
  const events = (await complete({ ...body, stream: true }))
    .split("\n\n")
    .map((e) => e.replace(/^data: /, ""))
    .filter((e) => e && e !== "[DONE]")
    .map((e) => JSON.parse(e));
  const deltas = events.map((e) => e.choices[0]);
  return {
    text: deltas.map((c) => c.delta.content ?? "").join(""),
    toolCall: deltas.find((c) => c.delta.tool_calls)?.delta.tool_calls[0].function,
    finishReason: deltas[deltas.length - 1].finish_reason,
  };
}

describe("fake LLM", () => {
  it("streams the canned reply that matches the user's message", async () => {
    const reply = await streamed({
      messages: [{ role: "user", content: "What's on my plate this week?" }],
    });
    expect(reply.text).toContain("Here's where your week stands");
    expect(reply.finishReason).toBe("stop");
  });

  it("calls a tool first, then answers once the tool has run", async () => {
    const ask = { role: "user", content: "Add a task to send the rollout plan to Priya" };
    const call = await streamed({ messages: [ask], tools: CREATE_TASK_TOOL });
    expect(call.toolCall.name).toBe("create_task");
    expect(call.finishReason).toBe("tool_calls");

    const answer = await streamed({
      messages: [ask, { role: "assistant", content: null }, { role: "tool", content: "{}" }],
      tools: CREATE_TASK_TOOL,
    });
    expect(answer.text).toContain("Send the rollout plan to Priya");
  });

  it("answers in text when the tool it wants isn't offered", async () => {
    const reply = await streamed({
      messages: [{ role: "user", content: "Add a task to send the rollout plan to Priya" }],
      tools: [],
    });
    expect(reply.toolCall).toBeUndefined();
    expect(reply.text).toContain("Send the rollout plan to Priya");
  });

  it("answers Omni's layout builder with a spec block", async () => {
    const reply = await streamed({
      messages: [
        { role: "system", content: "You are a UI generator that outputs JSON." },
        { role: "user", content: "Build me a focus board" },
      ],
    });
    expect(reply.text).toContain("```spec");
    expect(reply.text).toContain('"path":"/root"');
  });

  it("ignores the screen snapshot Omni Chat sends after the user's message", async () => {
    const reply = await streamed({
      messages: [
        { role: "user", content: "Summarize what I'm looking at" },
        { role: "user", content: "<screen-context-abc>Tasks: …</screen-context-abc>" },
      ],
    });
    expect(reply.text).toContain("You're on your task list");
  });

  it("answers a non-streaming request with a whole completion", async () => {
    const body = JSON.parse(await complete({ messages: [{ role: "user", content: "hello" }] }));
    expect(body.choices[0].message.content).toContain("scripted demo reply");
  });
});
