import type { Alarm } from "./alarms";
import { localFeaturesAvailable } from "./core";

/**
 * Rings alarms in a plain browser tab, where the desktop app's native ringer
 * (`src-tauri/src/alarms.rs`) isn't there to do it. It chimes with the same
 * timing and escalation, posts a browser notification, flashes the tab title
 * and asks for full screen.
 *
 * Browsers limit what a page may do on its own. Sound plays only after the
 * user has clicked or typed somewhere on the page, and some browsers ignore a
 * notification permission request made without one, so `primeAlarmAudio`
 * unlocks sound and asks for notifications on the first gesture. Full screen needs a click right before the
 * request, so it usually fails at fire time; the overlay still covers the tab.
 */

/**
 * True where something native already rings: the Tauri app, or the macOS
 * app's web UI window, which marks its user agent with `YarvisMac`.
 */
export function ringsNatively(): boolean {
  return localFeaturesAvailable() || navigator.userAgent.includes("YarvisMac");
}

/** Seconds after firing before the chime gets louder and more frequent. */
export const ESCALATE_AFTER_SECS = 60;

/** How loud and how often to chime, given how long the alarm has rung. */
export function chimeAt(secondsOverdue: number): { gain: number; gapMs: number } {
  return secondsOverdue >= ESCALATE_AFTER_SECS
    ? { gain: 0.5, gapMs: 2_000 }
    : { gain: 0.25, gapMs: 5_000 };
}

// Ringing state for this tab. Everything but the audio unlock resets when the
// takeover queue empties.
let audio: AudioContext | null = null;
/** True while the first-gesture listeners wait for a click or key press. */
let listening = false;
let chimeTimer: ReturnType<typeof setTimeout> | undefined;
/** When the longest-ringing alarm with sound was due, which sets the escalation. */
let oldestFireAtMs = 0;
let titleTimer: ReturnType<typeof setInterval> | undefined;
/** The label the flashing title shows: the front of the queue. */
let titleLabel = "";
let savedTitle: string | null = null;
let enteredFullscreen = false;
const notified = new Set<string>();

/** Runs inside the page's first user gesture, where browsers allow sound and permission prompts. */
function onFirstGesture(): void {
  stopListening();
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission();
  }
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
  } catch {
    // No Web Audio: the alarm still shows, just silently.
  }
}

function stopListening(): void {
  listening = false;
  window.removeEventListener("pointerdown", onFirstGesture, { capture: true });
  window.removeEventListener("keydown", onFirstGesture, { capture: true });
}

/**
 * Unlocks sound and asks for notifications on the page's next click or key
 * press. Does nothing once sound is unlocked or while already waiting, so it
 * is safe to call on every mount.
 */
export function primeAlarmAudio(): void {
  if (audio || listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("pointerdown", onFirstGesture, { capture: true });
  window.addEventListener("keydown", onFirstGesture, { capture: true });
}

/** Two short tones, like a doorbell, so it reads as an alert rather than a beep. */
function chime(gain: number): void {
  const ctx = audio;
  if (ctx?.state !== "running") return;
  const now = ctx.currentTime;
  for (const [offset, freq] of [
    [0, 880],
    [0.25, 660],
  ] as const) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0, now + offset);
    env.gain.linearRampToValueAtTime(gain, now + offset + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.6);
    osc.connect(env).connect(ctx.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.65);
  }
}

function notify(alarm: Alarm): void {
  if (notified.has(alarm.id) || typeof Notification === "undefined") return;
  notified.add(alarm.id);
  const show = () => {
    const note = new Notification("Alarm", { body: alarm.label, tag: `alarm.${alarm.id}` });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  };
  if (Notification.permission === "granted") show();
}

function startChiming(): void {
  if (chimeTimer) return;
  const tick = () => {
    const overdue = Math.max(0, Math.floor((Date.now() - oldestFireAtMs) / 1000));
    const { gain, gapMs } = chimeAt(overdue);
    chime(gain);
    chimeTimer = setTimeout(tick, gapMs);
  };
  tick();
}

function stopChiming(): void {
  clearTimeout(chimeTimer);
  chimeTimer = undefined;
}

function flashTitle(label: string): void {
  titleLabel = label;
  if (titleTimer) return;
  savedTitle = document.title;
  let on = false;
  titleTimer = setInterval(() => {
    on = !on;
    document.title = on ? `⏰ ${titleLabel}` : (savedTitle ?? "");
  }, 1_000);
}

function stopFlashingTitle(): void {
  clearInterval(titleTimer);
  titleTimer = undefined;
  if (savedTitle !== null) document.title = savedTitle;
  savedTitle = null;
}

function enterFullscreen(): void {
  const root = document.documentElement;
  if (document.fullscreenElement || !root.requestFullscreen) return;
  root
    .requestFullscreen()
    .then(() => {
      enteredFullscreen = true;
    })
    .catch(() => {
      // Refused without a recent click. The overlay still fills the tab.
    });
}

function exitFullscreen(): void {
  if (enteredFullscreen && document.fullscreenElement)
    void document.exitFullscreen().catch(() => {});
  enteredFullscreen = false;
}

/**
 * Matches the ringing to the takeover queue: rings while it holds anything,
 * goes quiet when it empties. The chime plays only if some alarm in the queue
 * has sound on, and escalates with the oldest of them.
 */
export function syncBrowserAlarms(queue: Alarm[]): void {
  if (queue.length === 0) {
    stopChiming();
    stopFlashingTitle();
    exitFullscreen();
    notified.clear();
    return;
  }
  for (const alarm of queue) notify(alarm);
  flashTitle(queue[0].label);
  enterFullscreen();
  const sounding = queue.filter((a) => a.sound);
  if (sounding.length === 0) stopChiming();
  else {
    oldestFireAtMs = Math.min(...sounding.map((a) => a.fireAtMs));
    startChiming();
  }
}
