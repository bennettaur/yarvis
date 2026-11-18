/**
 * The JSON-RPC reply in an MCP endpoint response. The endpoint streams its
 * replies as server-sent events, so this reads the stream to its end and
 * returns the message carrying a result or an error, skipping notifications.
 */
export async function mcpReply<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(text);
  const messages = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length)));
  const reply = messages.find((m) => "result" in m || "error" in m);
  if (!reply) throw new Error(`no reply in the stream: ${text}`);
  return reply as T;
}
