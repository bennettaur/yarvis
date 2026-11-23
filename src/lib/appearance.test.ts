import { describe, expect, it } from "bun:test";
import { loadAppearance } from "./appearance";

/** A fake sign-in state: `signIn()` fires the listeners `loadAppearance` registered. */
function fakeDevice(token: string | null) {
  const listeners: Array<(signedIn: boolean) => void> = [];
  let loads = 0;
  return {
    get loads() {
      return loads;
    },
    signIn: () => {
      for (const listener of listeners) listener(true);
    },
    deps: {
      token: async () => token,
      onAuth: (cb: (signedIn: boolean) => void) => {
        listeners.push(cb);
        return () => {};
      },
      load: async () => {
        loads += 1;
        return { colorTheme: null, terminalFontSize: null, attentionAnimation: null };
      },
    },
  };
}

describe("loadAppearance", () => {
  it("loads the settings straight away for a signed-in device", async () => {
    const device = fakeDevice("token");
    await loadAppearance(device.deps);
    expect(device.loads).toBe(1);
  });

  // Asking first would only get a 401 and log an error.
  it("waits for sign-in before asking for the settings", async () => {
    const device = fakeDevice(null);
    await loadAppearance(device.deps);
    expect(device.loads).toBe(0);

    device.signIn();
    expect(device.loads).toBe(1);
  });
});
