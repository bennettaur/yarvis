import { Easing, interpolate, spring } from "remotion";

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

/** The app window's own size, in the app's CSS pixels, before the camera scales it. */
export const APP_WIDTH = 1200;
export const APP_HEIGHT = 760;

/** Seconds to frames. */
export const sec = (seconds: number) => Math.round(seconds * FPS);

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0 → 1 over `duration` frames from `start`, eased. */
export function progress(
  frame: number,
  start: number,
  duration: number,
  easing: (t: number) => number = Easing.inOut(Easing.cubic),
) {
  return interpolate(frame, [start, start + duration], [0, 1], { ...clamp, easing });
}

/** A fade and rise for an element entering at `start`. */
export function enter(frame: number, start: number, duration = 12, rise = 16) {
  const t = progress(frame, start, duration, Easing.out(Easing.cubic));
  return { opacity: t, transform: `translateY(${(1 - t) * rise}px)` };
}

/** A spring from 0 to 1 starting at `start`, for pops and settles. */
export function pop(frame: number, start: number, damping = 14) {
  return spring({ frame: frame - start, fps: FPS, config: { damping, mass: 0.6 } });
}

/** The part of `text` typed by `frame`, at `cps` characters per second from `start`. */
export function typed(text: string, frame: number, start: number, cps = 28) {
  if (frame < start) return "";
  const chars = Math.floor(((frame - start) / FPS) * cps);
  return text.slice(0, chars);
}

/** Frames needed to type `text` at `cps`. */
export const typingFrames = (text: string, cps = 28) => Math.ceil((text.length / cps) * FPS);

/** A caret that blinks twice a second. */
export const caretOn = (frame: number) => Math.floor(frame / 15) % 2 === 0;
