import type { Alarm } from "./alarms";
import { localFeaturesAvailable } from "./core";

/**
 * Rings alarms in a plain browser tab, where the desktop app's native ringer
 * (`src-tauri/src/alarms.rs`) isn't there to do it. It chimes with the same
 * timing and escalation, posts a browser notification, flashes the tab title
 * and asks for full screen.
 *
 * Browsers limit what a page may do on its own. Sound plays only after the
 * user has clicked or typed somewhere on the page, so `primeAlarmAudio`
 * unlocks it on the first gesture. Full screen needs a click right before the
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

let audio: AudioContext | null = null;
let primed = false;

/** Creates or resumes the audio context inside a user gesture, where browsers allow it. */
function unlockAudio(): void {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
  } catch {
    // No Web Audio: the alarm still shows, just silently.
  }
}

/** Unlocks sound on the page's first click or key press. Safe to call repeatedly. */
export function primeAlarmAudio(): void {
  if (primed || typeof window === "undefined") return;
  primed = true;
  window.addEventListener("pointerdown", unlockAudio, { once: true, capture: true });
  window.addEventListener("keydown", unlockAudio, { once: true, capture: true });
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

let chimeTimer: ReturnType<typeof setTimeout> | undefined;
let titleTimer: ReturnType<typeof setInterval> | undefined;
let savedTitle: string | null = null;
let enteredFullscreen = false;
const notified = new Set<string>();

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
  else if (Notification.permission === "default") {
    void Notification.requestPermission().then((p) => p === "granted" && show());
  }
}

/** When the longest-ringing alarm with sound was due, which sets the escalation. */
let oldestFireAtMs = 0;

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
  if (titleTimer) return;
  savedTitle = document.title;
  let on = false;
  titleTimer = setInterval(() => {
    on = !on;
    document.title = on ? `⏰ ${label}` : (savedTitle ?? "");
  }, 1_000);
}

function stopTitle(): void {
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
    stopTitle();
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
