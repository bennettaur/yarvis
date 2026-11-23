import { mock } from "bun:test";
import { passThrough } from "./passThrough";

/**
 * Per-test answers for the terminal client in `lib/pty`; see `passThrough.ts`.
 * Clear them with `resetPtyApi` in the suite's `afterAll`.
 */
const actual = { ...(await import("../lib/pty")) };
const pty = passThrough(actual);
mock.module("../lib/pty", () => pty.module);

/** The real client, for testing its socket handling. */
export const realPty: Readonly<typeof actual> = actual;

/** Adds to the overrides already set; they last until `resetPtyApi`. */
export const stubPtyApi = pty.stub;
export const resetPtyApi = pty.reset;
