/**
 * Default answers for the Rust core's `invoke` commands, shared by every
 * frontend test.
 *
 * `mock.module` replaces a module for the *whole run*, not just the file that
 * calls it, so a suite that installs its own `@tauri-apps/api/core` stub takes
 * over from `src/test/setup.ts` for every file that runs after it too. A stub
 * that answers `undefined` for a command it doesn't care about therefore breaks
 * an unrelated suite whose component reads a field off the result — and only
 * when the file order puts them in that sequence, which differs between
 * machines. Per-file stubs delegate here for anything they don't handle, so
 * whichever one is live still answers every command the same way.
 */

const DEFAULTS: Record<string, unknown> = {
  // An empty list so alarm-aware components render without any alarms set.
  list_alarms: [],
  // The core always resolves an agent with non-empty fields, and the workspace
  // view renders its name unguarded.
  get_agent_config: { name: "Claude", command: "claude --permission-mode auto" },
};

export const nativeInvoke = async (command: string): Promise<unknown> => DEFAULTS[command];
