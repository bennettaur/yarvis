import { mock } from "bun:test";
import { passThrough } from "./passThrough";

/**
 * Per-test answers for the PR client in `lib/pr/api`; see `passThrough.ts`.
 * Clear them with `resetPrApi` in the suite's `afterAll`.
 */
const prApi = passThrough({ ...(await import("../lib/pr/api")) });
mock.module("../lib/pr/api", () => prApi.module);

/** Adds to the overrides already set; they last until `resetPrApi`. */
export const stubPrApi = prApi.stub;
export const resetPrApi = prApi.reset;
