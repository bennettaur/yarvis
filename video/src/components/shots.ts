import { APP_HEIGHT, APP_WIDTH } from "../lib/timing";
import type { Shot } from "./Camera";

/** The whole window, to the right of the caption column. */
export const framed = (at: number, dur = 24): Shot => ({
  at,
  dur,
  x: APP_WIDTH / 2,
  y: APP_HEIGHT / 2,
  zoom: 1,
  sx: 1265,
  sy: 545,
});

/** The window swinging in from a turned, pulled-back start. */
export const swingIn = (at = 0): Shot[] => [
  { at, x: APP_WIDTH / 2, y: APP_HEIGHT / 2, zoom: 0.7, sx: 1460, sy: 600, rotY: -26, rotX: 6 },
  framed(at + 4, 30),
];

/** Close in on a point of the app, keeping it right of the caption column. */
export const closeUp = (at: number, x: number, y: number, zoom: number, dur = 26): Shot => ({
  at,
  dur,
  x,
  y,
  zoom,
  sx: 1280,
  sy: 560,
});

/** Full-bleed: the window centred with no caption column. */
export const centred = (at: number, zoom: number, dur = 26): Shot => ({
  at,
  dur,
  x: APP_WIDTH / 2,
  y: APP_HEIGHT / 2,
  zoom,
});
