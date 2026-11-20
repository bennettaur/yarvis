import { mock } from "bun:test";
import { passThrough } from "./passThrough";

/**
 * Per-test answers for the repo client in `lib/repos`; see `passThrough.ts`.
 * Clear them with `resetReposApi` in the suite's `afterAll`.
 */
const repos = passThrough({ ...(await import("../lib/repos")) });
mock.module("../lib/repos", () => repos.module);

/** Adds to the overrides already set; they last until `resetReposApi`. */
export const stubReposApi = repos.stub;
export const resetReposApi = repos.reset;
