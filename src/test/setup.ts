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

// Native commands whose callers read fields off the result, so `undefined`
// would throw during render rather than degrade. The rest answer `undefined`.
const NATIVE_DEFAULTS: Record<string, unknown> = {
  // An empty list so alarm-aware components render without any alarms set.
  list_alarms: [],
  // The core always resolves an agent to non-empty defaults, and the workspace
  // view renders its name unguarded.
  get_agent_config: { name: "Claude", command: "claude --permission-mode auto" },
};

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => NATIVE_DEFAULTS[command],
}));

mock.module("@tauri-apps/api/event", () => ({
  // No events fire in tests; return a no-op unlisten.
  listen: async () => () => {},
}));

mock.module("@tauri-apps/plugin-opener", () => ({
  openUrl: async () => {},
}));

mock.module("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  sendNotification: () => {},
}));
