/**
 * The native-messaging host Chrome launches for the Yarvis extension.
 *
 * The extension talks to this process over stdio, and this process talks to
 * every running Yarvis sidecar over its loopback HTTP API: for each one it
 * long-polls `/browser/next` for a command, hands it to the extension, and posts
 * the extension's answer back to the sidecar that asked. Keeping the network
 * half here means the extension needs no host permission for localhost and
 * never sees a sidecar's port or token — both come from the discovery files each
 * sidecar writes on launch.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeFrame, FrameDecoder } from "./frames.ts";
import { type Instance, instancesDir, parseInstance } from "./instances.ts";

const RETRY_MS = 3_000;
const RESCAN_MS = 3_000;

/** A reply that never comes (the tab hung) must not hold its route forever. */
const PENDING_TTL_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function send(message: unknown): void {
  process.stdout.write(encodeFrame(message));
}

/** Who this Chrome profile is. Nothing is polled until the extension says. */
let profile: { id: string; name: string } | null = null;

interface Poller {
  instance: Instance;
  connected: boolean;
  stopped: boolean;
  /** Aborts the poll in flight, so a renamed profile is re-announced at once. */
  inflight: AbortController | null;
}

/** Keyed by file name, so a restarted instance replaces its old poller. */
const pollers = new Map<string, Poller>();

/** Which sidecar each command came from, so the answer goes back to it. */
const pending = new Map<string, { instance: Instance; at: number }>();

function statusMessage() {
  return {
    type: "status",
    instances: [...pollers.values()].map((p) => ({
      name: p.instance.name,
      port: p.instance.port,
      connected: p.connected,
    })),
  };
}

let lastStatus = "";
function reportStatus(): void {
  const message = statusMessage();
  const serialized = JSON.stringify(message);
  if (serialized === lastStatus) return;
  lastStatus = serialized;
  send(message);
}

async function post(instance: Instance, message: { id: string }): Promise<void> {
  await fetch(`http://127.0.0.1:${instance.port}/browser/result`, {
    method: "POST",
    headers: { Authorization: `Bearer ${instance.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
}

function setConnected(poller: Poller, connected: boolean): void {
  if (poller.connected === connected) return;
  poller.connected = connected;
  reportStatus();
}

async function poll(poller: Poller): Promise<void> {
  const { instance } = poller;
  const headers = { Authorization: `Bearer ${instance.token}` };
  while (!poller.stopped) {
    if (!profile) {
      await sleep(250);
      continue;
    }
    // A long poll answers only when it has a command or its hold runs out, so a
    // quick ping is what shows the instance as connected straight away.
    if (!poller.connected) {
      try {
        const ping = await fetch(`http://127.0.0.1:${instance.port}/browser/ping`, { headers });
        setConnected(poller, ping.ok);
      } catch {
        setConnected(poller, false);
      }
      if (!poller.connected) {
        await sleep(RETRY_MS);
        continue;
      }
    }
    const query = new URLSearchParams({ profile: profile.id, name: profile.name });
    const controller = new AbortController();
    poller.inflight = controller;
    try {
      const res = await fetch(`http://127.0.0.1:${instance.port}/browser/next?${query}`, {
        headers,
        signal: controller.signal,
      });
      const ok = res.status === 200 || res.status === 204;
      setConnected(poller, ok);
      if (res.status === 200) {
        const item = (await res.json()) as { id: string };
        pending.set(item.id, { instance, at: Date.now() });
        try {
          send({ type: "command", ...item });
        } catch (error) {
          // Say so now rather than leave the tool to wait out its timeout.
          pending.delete(item.id);
          await post(instance, { id: item.id, ok: false, error: String(error) } as { id: string });
        }
      } else if (!ok) {
        // 409: another host is polling as this same profile. Back off so the two
        // don't take the poll from each other in a tight loop.
        await sleep(RETRY_MS);
      }
    } catch {
      // Our own abort (a rename) goes straight round; the sidecar requeues any
      // command it had already handed over.
      if (controller.signal.aborted) continue;
      setConnected(poller, false);
      await sleep(RETRY_MS);
    } finally {
      poller.inflight = null;
    }
  }
}

/**
 * A crashed sidecar leaves its file behind. Signal 0 checks the pid without
 * touching it; EPERM means the pid was reused by another user's process, which is
 * just as dead to us.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function rescan(): Promise<void> {
  const dir = instancesDir();
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith(".json"));
  } catch {
    // No instance has started yet.
  }

  const seen = new Set<string>();
  for (const file of files) {
    let instance: Instance | null = null;
    try {
      instance = parseInstance(JSON.parse(await readFile(join(dir, file), "utf8")));
    } catch {
      // Half-written or not ours; the next scan will see it whole.
    }
    if (!instance || !alive(instance.pid)) continue;
    seen.add(file);
    const current = pollers.get(file);
    if (
      current &&
      current.instance.port === instance.port &&
      current.instance.token === instance.token
    ) {
      continue;
    }
    if (current) current.stopped = true;
    const poller: Poller = { instance, connected: false, stopped: false, inflight: null };
    pollers.set(file, poller);
    void poll(poller);
  }
  for (const [file, poller] of pollers) {
    if (seen.has(file)) continue;
    poller.stopped = true;
    poller.inflight?.abort();
    pollers.delete(file);
  }

  const now = Date.now();
  for (const [id, entry] of pending) {
    if (now - entry.at > PENDING_TTL_MS) pending.delete(id);
  }
  reportStatus();
}

/** Extension → host: who this profile is, and answers to commands. */
const decoder = new FrameDecoder();
process.stdin.on("data", (chunk: Buffer) => {
  let messages: unknown[];
  try {
    messages = decoder.push(chunk);
  } catch {
    // A corrupt frame leaves the stream unrecoverable; end and let the extension reconnect.
    process.exit(1);
  }
  for (const raw of messages) {
    const message = raw as { type?: unknown; id?: unknown; profileId?: unknown; name?: unknown };
    if (message?.type === "hello") {
      if (typeof message.profileId === "string" && typeof message.name === "string") {
        const changed = profile?.id !== message.profileId || profile?.name !== message.name;
        profile = { id: message.profileId, name: message.name };
        // A held poll still carries the old name for up to its whole hold.
        if (changed) for (const poller of pollers.values()) poller.inflight?.abort();
      }
      // A popup opened after the last change still needs the current picture.
      lastStatus = "";
      reportStatus();
      continue;
    }
    if (typeof message?.id !== "string") continue;
    const route = pending.get(message.id);
    if (!route) continue;
    pending.delete(message.id);
    post(route.instance, message as { id: string }).catch(() => {
      // The sidecar restarted mid-command; the tool has already timed out.
    });
  }
});
// Chrome closes stdin when the extension disconnects or the browser quits.
process.stdin.on("end", () => process.exit(0));

for (;;) {
  await rescan();
  await sleep(RESCAN_MS);
}
