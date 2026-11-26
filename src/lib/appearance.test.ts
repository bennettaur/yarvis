import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { loadAppearance } from "./appearance";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  getTerminalFontSize,
  loadTerminalFontSize,
} from "./terminalFont";

/** A fake sign-in state: `signIn()` fires the listeners `loadAppearance`
 * registered, and resolves once the load it started has been applied. */
function fakeDevice(token: string | null, load?: () => Promise<never>) {
  const listeners: Array<(signedIn: boolean) => void> = [];
  let loads = 0;
  let loaded: Promise<unknown> = Promise.resolve();
  return {
    get loads() {
      return loads;
    },
    signIn: async () => {
      for (const listener of listeners) listener(true);
      await loaded;
    },
    deps: {
      token: async () => token,
      onAuth: (cb: (signedIn: boolean) => void) => {
        listeners.push(cb);
        return () => {};
      },
      load: () => {
        loads += 1;
        const result =
          load?.() ??
          Promise.resolve({ colorTheme: null, terminalFontSize: 20, attentionAnimation: null });
        loaded = result.catch(() => {});
        return result;
      },
    },
  };
}

describe("loadAppearance", () => {
  afterEach(() => loadTerminalFontSize(null));

  it("applies the settings straight away for a signed-in device", async () => {
    const device = fakeDevice("token");
    await loadAppearance(device.deps);
    expect(device.loads).toBe(1);
    expect(getTerminalFontSize()).toBe(20);
  });

  // Asking first would only get a 401 and log an error.
  it("waits for sign-in before asking for the settings", async () => {
    const device = fakeDevice(null);
    await loadAppearance(device.deps);
    expect(device.loads).toBe(0);
    expect(getTerminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE);

    await device.signIn();
    expect(device.loads).toBe(1);
    expect(getTerminalFontSize()).toBe(20);
  });

  // The first render waits on this, so a failed load must not hold it up.
  it("resolves with the defaults when the load fails", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const device = fakeDevice("token", () => Promise.reject(new Error("down")));
      await loadAppearance(device.deps);
      expect(getTerminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE);
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
