import { mock } from "bun:test";
import { passThrough } from "./passThrough";

/**
 * Per-test answers for the chat client in `lib/chat`; see `passThrough.ts`.
 * Clear them with `resetChatApi` in the suite's `afterAll`.
 */
const chat = passThrough({ ...(await import("../lib/chat")) });
mock.module("../lib/chat", () => chat.module);

/** Adds to the overrides already set; they last until `resetChatApi`. */
export const stubChatApi = chat.stub;
export const resetChatApi = chat.reset;
