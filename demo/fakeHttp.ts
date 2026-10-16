/** Plumbing shared by the fake GitHub, Google and JIRA servers. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FakeRequest {
  method: string;
  url: URL;
  body: unknown;
}

/** What a handler returns: a JSON body, or a raw text body, with a status. */
export type FakeResponse = { status?: number; json?: unknown; text?: string };

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    // Form bodies (the OAuth token endpoint) aren't JSON.
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

function send(res: ServerResponse, reply: FakeResponse): void {
  const status = reply.status ?? 200;
  if (reply.text !== undefined) {
    res.writeHead(status, { "Content-Type": "text/plain" }).end(reply.text);
  } else {
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(reply.json));
  }
}

/** Starts a loopback server that answers every request with `handle`. */
export function startFakeServer(
  name: string,
  port: number,
  handle: (req: FakeRequest) => FakeResponse,
): Promise<Server> {
  const server = createServer((req, res) => {
    readBody(req)
      .then((body) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        send(res, handle({ method: req.method ?? "GET", url, body }));
      })
      .catch((e) => {
        console.error(`[${name}]`, e);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
