import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mountForInteraction, waitFor } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";
import BootGate from "./BootGate";

let failHealthCheck: (() => void) | undefined;
let healthCheckFailed: Promise<void> = Promise.resolve();
stubSidecarApi({
  // A check that stays pending until the test fails it.
  getHealth: () => {
    const check = new Promise<never>((_, reject) => {
      failHealthCheck = () => reject(new Error("the sidecar isn't running right now"));
    });
    healthCheckFailed = check.catch(() => {});
    return check;
  },
});
afterAll(resetSidecarApi);

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

describe("BootGate", () => {
  it("stays out of the way after Continue anyway, though the sidecar is still down", async () => {
    const mounted = await mountForInteraction(
      <BootGate slowAfterMs={10}>
        <p>the app</p>
      </BootGate>,
    );
    unmount = mounted.unmount;
    const continueAnyway = () =>
      [...mounted.host.querySelectorAll("button")].find((b) => b.textContent === "Continue anyway");
    await waitFor(() => continueAnyway() !== undefined, "Continue anyway");
    continueAnyway()?.click();
    await waitFor(() => mounted.host.textContent === "the app", "the app");

    // The check that was running when the user clicked fails afterwards.
    failHealthCheck?.();
    await healthCheckFailed;
    await new Promise((r) => setTimeout(r, 0));
    expect(mounted.host.textContent).toBe("the app");
  });
});
