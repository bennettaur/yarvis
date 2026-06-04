// Pin the timezone before any Date/Intl use so date-sensitive tests (DST
// bucketing, week/month boundaries) are deterministic regardless of the host's
// zone — CI runners default to UTC, which has no DST transitions to exercise.
process.env.TZ = "America/Toronto";

import { mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Frontend test setup, preloaded for every `bun test` run under src/ (see
 * bunfig.toml). It registers a happy-dom global environment so React can render
 * into a real DOM, and stubs the Tauri runtime APIs — which only exist inside
 * the desktop shell — with inert defaults. Tests that need specific sidecar
 * data mock `src/lib/api` (sidecarFetch) themselves.
 */

if (!("happyDOM" in globalThis)) {
  GlobalRegistrator.register();
}

mock.module("@tauri-apps/api/core", () => ({
  // Default native command responses; list_alarms returns an empty list so
  // alarm-aware components render without any alarms set.
  invoke: async (command: string) => (command === "list_alarms" ? [] : undefined),
}));

mock.module("@tauri-apps/api/event", () => ({
  // No events fire in tests; return a no-op unlisten.
  listen: async () => () => {},
}));

mock.module("@tauri-apps/plugin-opener", () => ({
  openUrl: async () => {},
}));
