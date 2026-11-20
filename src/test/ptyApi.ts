import { mock } from "bun:test";
import { passThrough } from "./passThrough";

/**
 * Per-test answers for the terminal client in `lib/pty`; see `passThrough.ts`.
 * Clear them with `resetPtyApi` in the suite's `afterAll`.
 */
const pty = passThrough({ ...(await import("../lib/pty")) });
mock.module("../lib/pty", () => pty.module);

/** Adds to the overrides already set; they last until `resetPtyApi`. */
export const stubPtyApi = pty.stub;
export const resetPtyApi = pty.reset;
