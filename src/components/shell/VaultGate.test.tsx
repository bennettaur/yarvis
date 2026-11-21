import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { saveDeviceToken, signOut } from "../../lib/server";
import { mountForInteraction, waitFor } from "../../test/render";
import { stubServerRoutes } from "../../test/serverRoutes";
import VaultGate from "./VaultGate";

let vault = "locked";
const server = stubServerRoutes({
  "GET /api/auth/status": () => Response.json({ setupRequired: false, rpId: "localhost", vault }),
  "POST /api/vault/unlock/recovery": () => {
    vault = "unlocked";
    return Response.json({ state: "unlocked" });
  },
});
afterAll(() => {
  server.restore();
  signOut();
});

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
  server.calls.length = 0;
  vault = "locked";
});

const gate = () => createElement(VaultGate, null, createElement("p", null, "the app"));

/** Sets an input's value the way React notices. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("VaultGate", () => {
  it("passes straight through when the server keeps no vault", async () => {
    vault = "absent";
    saveDeviceToken("tok-me");
    const mounted = await mountForInteraction(gate());
    unmount = mounted.unmount;
    await waitFor(() => mounted.host.textContent === "the app", "the app");
  });

  it("holds the app until the recovery key opens the vault", async () => {
    saveDeviceToken("tok-me");
    const mounted = await mountForInteraction(gate());
    unmount = mounted.unmount;
    await waitFor(
      () => mounted.host.textContent?.includes("vault is locked") ?? false,
      "the unlock screen",
    );
    expect(mounted.host.textContent).not.toContain("the app");

    const input = mounted.host.querySelector("input") as HTMLInputElement;
    type(input, " RK-1234 ");
    const submit = [...mounted.host.querySelectorAll("button")].find(
      (b) => b.textContent === "Unlock with recovery key",
    ) as HTMLButtonElement;
    await waitFor(() => !submit.disabled, "the submit button");
    submit.click();

    await waitFor(() => mounted.host.textContent === "the app", "the app after unlock");
    expect(server.calls.find((c) => c.route === "POST /api/vault/unlock/recovery")?.body).toEqual({
      recoveryKey: "RK-1234",
    });
  });

  it("tells an uninitialized server's user how to create the vault", async () => {
    vault = "uninitialized";
    saveDeviceToken("tok-me");
    const mounted = await mountForInteraction(gate());
    unmount = mounted.unmount;
    await waitFor(
      () => mounted.host.textContent?.includes("yarvis-server vault init") ?? false,
      "the init hint",
    );
  });
});
