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

/** Characters per second typed into a composer or terminal, unless a script says otherwise. */
export const TYPE_CPS = 28;

/** The part of `text` typed by `frame`, at `cps` characters per second from `start`. */
export function typed(text: string, frame: number, start: number, cps = TYPE_CPS) {
  if (frame < start) return "";
  const chars = Math.floor(((frame - start) / FPS) * cps);
  return text.slice(0, chars);
}

/** Frames needed to type `text` at `cps`. */
export const typingFrames = (text: string, cps = TYPE_CPS) => Math.ceil((text.length / cps) * FPS);

/** A caret that blinks once a second: on for half a second, off for half. */
export const caretOn = (frame: number) => Math.floor(frame / (FPS / 2)) % 2 === 0;

/** A composer's text with the blinking caret after it, or empty when there is nothing typed. */
export const withCaret = (text: string, frame: number) =>
  text ? `${text}${caretOn(frame) ? "▏" : ""}` : "";
