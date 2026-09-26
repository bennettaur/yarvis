/**
 * The native-messaging host Chrome launches for the Yarvis extension.
 *
 * The extension talks to this process over stdio, and this process talks to the
 * sidecar over its loopback HTTP API: it long-polls `/browser/next` for a
 * command, hands it to the extension, and posts the extension's answer to
 * `/browser/result`. Keeping the network half here means the extension needs no
 * host permission for localhost and never sees the sidecar's port or token —
 * both are read from the discovery file the sidecar writes on each launch.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeFrame, FrameDecoder } from "./frames.ts";

interface Discovery {
  port: number;
  token: string;
}

const RETRY_MS = 3_000;

function discoveryPath(): string {
  return process.env.YARVIS_BROWSER_DISCOVERY_PATH ?? join(homedir(), ".yarvis", "browser.json");
}

async function readDiscovery(): Promise<Discovery | null> {
  try {
    const parsed = JSON.parse(await readFile(discoveryPath(), "utf8"));
    if (
      Number.isInteger(parsed.port) &&
      parsed.port > 0 &&
      parsed.port < 65536 &&
      typeof parsed.token === "string"
    ) {
      return parsed;
    }
  } catch {
    // Not written yet: Yarvis isn't running.
  }
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function send(message: unknown): void {
  process.stdout.write(encodeFrame(message));
}

async function post(target: Discovery, message: { id: string }): Promise<void> {
  await fetch(`http://127.0.0.1:${target.port}/browser/result`, {
    method: "POST",
    headers: { Authorization: `Bearer ${target.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
}

/** Extension → sidecar: the answer to a command. */
const decoder = new FrameDecoder();
process.stdin.on("data", (chunk: Buffer) => {
  let messages: unknown[];
  try {
    messages = decoder.push(chunk);
  } catch {
    // A corrupt frame leaves the stream unrecoverable; end and let the extension reconnect.
    process.exit(1);
  }
  for (const message of messages) {
    if (typeof (message as { id?: unknown })?.id !== "string") continue;
    readDiscovery()
      .then((target) => target && post(target, message as { id: string }))
      .catch(() => {
        // The sidecar restarted mid-command; the tool has already timed out.
      });
  }
});
// Chrome closes stdin when the extension disconnects or the browser quits.
process.stdin.on("end", () => process.exit(0));

/** Sidecar → extension: poll until the process ends. */
for (;;) {
  const target = await readDiscovery();
  if (!target) {
    await sleep(RETRY_MS);
    continue;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${target.port}/browser/next`, {
      headers: { Authorization: `Bearer ${target.token}` },
    });
    if (res.status === 200) {
      const item = (await res.json()) as { id: string };
      try {
        send({ type: "command", ...item });
      } catch (error) {
        // Say so now rather than leave the tool to wait out its timeout.
        await post(target, { id: item.id, ok: false, error: String(error) } as { id: string });
      }
    } else if (res.status !== 204) {
      // 409: another host (a second Chrome profile) holds the poll. Back off so
      // the two don't take it from each other in a tight loop.
      await sleep(RETRY_MS);
    }
  } catch {
    await sleep(RETRY_MS);
  }
}
