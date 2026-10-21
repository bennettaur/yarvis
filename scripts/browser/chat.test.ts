import { describe, expect, it } from "bun:test";
import { chatRequest, relayChat, SseDecoder } from "./chat.ts";
import type { Instance } from "./instances.ts";

const SESSION = "6f1c2a8e-4b1d-4c3a-9e2f-0a1b2c3d4e5f";
const instance: Instance = { name: "main", port: 4321, token: "browser-token", pid: 1 };

describe("chatRequest", () => {
  it("maps each panel operation onto a fixed route", () => {
    expect(chatRequest({ op: "sessions" })).toMatchObject({
      method: "GET",
      path: "/browser/chat/sessions",
    });
    expect(chatRequest({ op: "messages", sessionId: SESSION })?.path).toBe(
      `/browser/chat/sessions/${SESSION}/messages`,
    );
    expect(
      chatRequest({ op: "send", sessionId: SESSION, message: "hi", tab: { tabId: 1 } }),
    ).toEqual({
      method: "POST",
      path: "/browser/chat",
      body: { sessionId: SESSION, message: "hi", tab: { tabId: 1 } },
      stream: true,
    });
  });

  it("sends an approval to the call it names", () => {
    expect(chatRequest({ op: "approve", toolCallId: "toolu_01AB", approved: false })).toEqual({
      method: "POST",
      path: "/browser/chat/approvals/toolu_01AB",
      body: { approved: false },
      stream: false,
    });
  });

  it("refuses an unknown operation or a session id that could change the path", () => {
    expect(chatRequest({ op: "delete" })).toBeNull();
    expect(chatRequest({ op: "messages", sessionId: "../../api/tasks" })).toBeNull();
    expect(chatRequest({ op: "send", sessionId: "nope", message: "hi" })).toBeNull();
    expect(chatRequest({ op: "approve", toolCallId: "../x", approved: true })).toBeNull();
    expect(chatRequest({ op: "approve", toolCallId: "toolu_1", approved: "yes" })).toBeNull();
    expect(chatRequest(null)).toBeNull();
  });
});

describe("SseDecoder", () => {
  it("reassembles events split across chunks", () => {
    const decoder = new SseDecoder();
    expect(decoder.push('data: {"type":"del')).toEqual([]);
    expect(decoder.push('ta","text":"hi"}\n\ndata: {"type":"done"}\n\n')).toEqual([
      { type: "delta", text: "hi" },
      { type: "done" },
    ]);
  });

  it("drops an event that isn't JSON", () => {
    expect(new SseDecoder().push("data: nope\n\n")).toEqual([]);
  });
});

describe("relayChat", () => {
  it("sends the scoped token and streams each event back", async () => {
    let seen: Request | undefined;
    const fetchImpl = (async (input: string, init: RequestInit) => {
      seen = new Request(input, init);
      return new Response('data: {"type":"delta","text":"a"}\n\ndata: {"type":"done"}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const events: unknown[] = [];
    const request = chatRequest({ op: "send", sessionId: SESSION, message: "hi" });
    if (!request) throw new Error("expected a request");
    const reply = await relayChat(
      instance,
      request,
      (event) => events.push(event),
      new AbortController().signal,
      fetchImpl,
    );
    expect(reply).toEqual({ ok: true });
    expect(events).toEqual([{ type: "delta", text: "a" }, { type: "done" }]);
    expect(seen?.url).toBe("http://127.0.0.1:4321/browser/chat");
    expect(seen?.headers.get("authorization")).toBe("Bearer browser-token");
  });

  it("fails a turn whose stream ends without done or error", async () => {
    const fetchImpl = (async () =>
      new Response('data: {"type":"delta","text":"a"}\n\n')) as unknown as typeof fetch;
    const request = chatRequest({ op: "send", sessionId: SESSION, message: "hi" });
    if (!request) throw new Error("expected a request");
    expect(
      await relayChat(instance, request, () => {}, new AbortController().signal, fetchImpl),
    ).toEqual({ ok: false, error: "The turn ended without an answer." });
  });

  it("returns the body of a request that isn't streamed", async () => {
    const fetchImpl = (async () => Response.json([{ id: SESSION }])) as unknown as typeof fetch;
    const request = chatRequest({ op: "sessions" });
    if (!request) throw new Error("expected a request");
    expect(
      await relayChat(instance, request, () => {}, new AbortController().signal, fetchImpl),
    ).toEqual({ ok: true, data: [{ id: SESSION }] });
  });

  it("names the status when the error isn't JSON", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const request = chatRequest({ op: "sessions" });
    if (!request) throw new Error("expected a request");
    expect(
      await relayChat(instance, request, () => {}, new AbortController().signal, fetchImpl),
    ).toEqual({ ok: false, error: "Yarvis answered 500." });
  });

  it("passes the sidecar's error back", async () => {
    const fetchImpl = (async () =>
      Response.json(
        { error: "No LLM provider is configured." },
        { status: 400 },
      )) as unknown as typeof fetch;
    const request = chatRequest({ op: "sessions" });
    if (!request) throw new Error("expected a request");
    expect(
      await relayChat(instance, request, () => {}, new AbortController().signal, fetchImpl),
    ).toEqual({ ok: false, error: "No LLM provider is configured." });
  });
});
