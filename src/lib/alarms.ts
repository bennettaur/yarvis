import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Alarm {
  id: string;
  label: string;
  fireAtMs: number;
  sound: boolean;
  status: string;
}

export const listAlarms = () => invoke<Alarm[]>("list_alarms");

export const createAlarm = (label: string, fireAtMs: number, sound = true) =>
  invoke<Alarm>("create_alarm", { label, fireAtMs, sound });

export const cancelAlarm = (id: string) => invoke("cancel_alarm", { id });

export const acknowledgeAlarm = (id: string) =>
  invoke("acknowledge_alarm", { id });

export const snoozeAlarm = (id: string, minutes: number) =>
  invoke("snooze_alarm", { id, minutes });

/** Subscribe to alarm-fired events from the Rust scheduler. */
export const onAlarmFired = (cb: (alarm: Alarm) => void): Promise<UnlistenFn> =>
  listen<Alarm>("alarm-fired", (e) => cb(e.payload));
