import { mock } from "bun:test";
import { passThrough } from "./passThrough";

/**
 * Per-test answers for the workspace client in `lib/workspaces`; see
 * `passThrough.ts`. Clear them with `resetWorkspacesApi` in the suite's
 * `afterAll`.
 */
const workspaces = passThrough({ ...(await import("../lib/workspaces")) });
mock.module("../lib/workspaces", () => workspaces.module);

/** Adds to the overrides already set; they last until `resetWorkspacesApi`. */
export const stubWorkspacesApi = workspaces.stub;
export const resetWorkspacesApi = workspaces.reset;
