import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ensureOk, sidecarFetch, streamSSE } from "./api";

/**
 * Client for alarms. The sidecar keeps the list (`/api/alarms`) and decides
 * when one is due; the Rust core rings it and emits `alarm-fired`.
 */

export interface Alarm {
  id: string;
  label: string;
  fireAtMs: number;
  sound: boolean;
  /** Join URL for a meeting-derived alarm; null for manually created alarms. */
  meetLink: string | null;
  status: string;
  /** Who set it. Absent on the payload the core forwards when an alarm fires. */
  source?: "app" | "chat" | "heads-down";
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await sidecarFetch(`/api/alarms${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await ensureOk(res, `${method} /api/alarms${path}`);
  return res.json() as Promise<T>;
}

export async function listAlarms(): Promise<Alarm[]> {
  const body = await request<unknown>("");
  // Anything but a list (an error page a proxy turned into JSON, say) counts
  // as a failed read, so the store keeps the list it had.
  if (!Array.isArray(body)) throw new Error("GET /api/alarms didn't return a list");
  return body as Alarm[];
}

export const createAlarm = (
  label: string,
  fireAtMs: number,
  sound = true,
  meetLink: string | null = null,
) => request<Alarm>("", "POST", { label, fireAtMs, sound, meetLink });

/**
 * Stops the alarm ringing on this machine first, so it goes quiet even when
 * the sidecar can't be reached to record what the user chose.
 */
async function releaseAndRecord(id: string, action: string, body?: unknown): Promise<Alarm> {
  await invoke("release_alarm", { id }).catch(() => {});
  return request<Alarm>(`/${id}/${action}`, "POST", body);
}

export const cancelAlarm = (id: string) => releaseAndRecord(id, "cancel");

export const acknowledgeAlarm = (id: string) => releaseAndRecord(id, "acknowledge");

export const snoozeAlarm = (id: string, minutes: number) =>
  releaseAndRecord(id, "snooze", { minutes });

/** Subscribe to alarm-fired events from the Rust core. */
export const onAlarmFired = (cb: (alarm: Alarm) => void): Promise<UnlistenFn> =>
  listen<Alarm>("alarm-fired", (e) => cb(e.payload));

/** How long to wait before reconnecting a dropped stream. */
const RECONNECT_MS = 5_000;

/**
 * Calls `onChange` whenever the alarm list changes on the sidecar: an agent
 * set one, the user acted in another window, one fired. Reconnects on its own
 * and calls `onChange` on each reconnect, since the stream doesn't replay what
 * it missed. Returns a function that stops it.
 */
export function followAlarmChanges(onChange: () => void): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = async () => {
    try {
      for await (const data of streamSSE("/api/alarms/stream", { signal: controller.signal })) {
        let event: { type?: string };
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.type === "changed") onChange();
      }
    } catch {
      // Dropped or never connected; retried below.
    }
    if (!controller.signal.aborted) {
      timer = setTimeout(() => {
        onChange();
        void connect();
      }, RECONNECT_MS);
    }
  };

  void connect();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
