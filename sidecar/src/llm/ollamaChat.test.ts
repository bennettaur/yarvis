import { describe, expect, it } from "bun:test";
import { ollamaChat } from "./ollamaChat.ts";

const answering = (content: string) =>
  (async () =>
    Response.json({ message: { content }, done_reason: "stop" })) as unknown as typeof fetch;

const request = (url: string, fetchImpl: typeof fetch) => ({
  target: { url, headers: {}, model: "jev" },
  messages: [{ role: "user" as const, content: "hi" }],
  format: { type: "object" },
  options: { num_ctx: 1024, num_predict: 64 },
  timeoutMs: 1000,
  fetchImpl,
});

describe("ollamaChat", () => {
  // A provider's base URL is held to the static check when it is saved and
  // when the AI SDK reaches it, so a LAN hostname that works for a chat turn
  // has to work here too.
  it("reaches a host by name without resolving it first", async () => {
    const reply = await ollamaChat(
      request("http://gpu-box.invalid:11434/api/chat", answering('{"ok":true}')),
    );
    expect(reply).toEqual({ content: '{"ok":true}', truncated: false });
  });

  it("still refuses a private address written as a literal", async () => {
    await expect(
      ollamaChat(request("http://192.168.1.5:11434/api/chat", answering("{}"))),
    ).rejects.toThrow("private address");
  });

  it("says when the reply stopped at the output limit", async () => {
    const fetchImpl = (async () =>
      Response.json({
        message: { content: "{" },
        done_reason: "length",
      })) as unknown as typeof fetch;
    const reply = await ollamaChat(request("http://127.0.0.1:11434/api/chat", fetchImpl));
    expect(reply.truncated).toBe(true);
  });
});
