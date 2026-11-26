import { mock } from "bun:test";
import { invoke } from "@tauri-apps/api/core";
import { passThrough } from "./passThrough";

/**
 * The one registration of `lib/core`, loaded by `setup.ts` for every suite.
 *
 * The real `core()` posts to the server, which tests don't have. By default
 * each call is answered by the Tauri `invoke` stub instead, with the same
 * command and arguments, so a suite that stubs `invoke` (or relies on
 * `nativeInvoke`'s defaults) answers `core()` too. A suite that wants its own
 * answers sets them with `stubCore` and clears them with `resetCore`.
 * `realCore` is the module itself, for testing the transport.
 */
const actual = { ...(await import("../lib/core")) };
export const realCore: Readonly<typeof actual> = actual;

const core = passThrough({
  ...actual,
  core: (command: string, args?: Record<string, unknown>) => invoke(command, args),
});
mock.module("../lib/core", () => core.module);

/** Adds to the overrides already set; they last until `resetCore`. */
export const stubCore = core.stub;
export const resetCore = core.reset;
