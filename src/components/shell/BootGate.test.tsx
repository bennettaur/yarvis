import { afterAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { mountForInteraction, waitFor } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";
import BootGate from "./BootGate";

let healthChecks = 0;
stubSidecarApi({
  getHealth: async () => {
    healthChecks++;
    throw new Error("the sidecar isn't running right now");
  },
});
afterAll(resetSidecarApi);

describe("BootGate", () => {
  it("stays out of the way after Continue anyway, though the sidecar is still down", async () => {
    const mounted = await mountForInteraction(
      createElement(BootGate, { slowAfterMs: 10 }, createElement("p", null, "the app")),
    );
    const skip = () =>
      [...mounted.host.querySelectorAll("button")].find((b) => b.textContent === "Continue anyway");
    await waitFor(() => skip() !== undefined, "Continue anyway");
    skip()?.click();
    await waitFor(() => mounted.host.textContent === "the app", "the app");

    // Two more failed checks would each have put the boot screen back.
    const seen = healthChecks;
    await new Promise((r) => setTimeout(r, 1_200));
    expect(healthChecks).toBeLessThanOrEqual(seen + 1);
    expect(mounted.host.textContent).toBe("the app");
    mounted.unmount();
  });
});
