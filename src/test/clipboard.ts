import { mock } from "bun:test";

/**
 * The one stub for `writeClipboard`, shared by every test that clicks a copy
 * button.
 *
 * It replaces the library function rather than the Rust core's
 * `clipboard_write` command: `mock.module` is process-global in bun, and a
 * dozen suites already install their own `@tauri-apps/api/core` stub, each
 * delegating unknown commands to `nativeInvoke` — which takes no arguments, so
 * the copied text is lost to whichever of them registered last. Stubbing one
 * layer up puts the recording somewhere no other suite competes for. The rest
 * of the module (the sanitizers, the entry API) passes through untouched.
 */

let written: string[] = [];
let failNext = false;

const actualClipboard = await import("../lib/clipboard");
mock.module("../lib/clipboard", () => ({
  ...actualClipboard,
  writeClipboard: async (text: string) => {
    if (failNext) throw new Error("clipboard unavailable");
    written.push(text);
  },
}));

/** What has been copied since the last {@link resetClipboardWrites}. */
export const clipboardWrites = (): string[] => written;

/** Makes the next copy throw, for the failure-feedback path. */
export const failNextClipboardWrite = (): void => {
  failNext = true;
};

/** Call from a `beforeEach` so one test's writes aren't read by the next. */
export const resetClipboardWrites = (): void => {
  written = [];
  failNext = false;
};
