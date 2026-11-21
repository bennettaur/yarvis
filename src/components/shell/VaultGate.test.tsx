import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { saveDeviceToken, signOut } from "../../lib/server";
import { fakeSockets, installFakeSockets } from "../../test/fakeSocket";
import { mountForInteraction, waitFor } from "../../test/render";
import { stubServerRoutes } from "../../test/serverRoutes";
import VaultGate from "./VaultGate";

let vault = "locked";
let recoveryKeyIsRight = true;
const server = stubServerRoutes({
  "GET /api/auth/status": () => Response.json({ setupRequired: false, rpId: "localhost", vault }),
  "POST /api/vault/unlock/recovery": () => {
    if (!recoveryKeyIsRight) {
      return Response.json({ error: "that recovery key doesn't open the vault" }, { status: 401 });
    }
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
  recoveryKeyIsRight = true;
});

async function submitRecoveryKey(host: HTMLElement, key: string) {
  type(host.querySelector("input") as HTMLInputElement, key);
  const submit = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Unlock with recovery key",
  ) as HTMLButtonElement;
  await waitFor(() => !submit.disabled, "the submit button");
  submit.click();
}

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

  it("shows the server's refusal and keeps the app hidden for a wrong key", async () => {
    recoveryKeyIsRight = false;
    saveDeviceToken("tok-me");
    const mounted = await mountForInteraction(gate());
    unmount = mounted.unmount;
    await waitFor(
      () => mounted.host.textContent?.includes("vault is locked") ?? false,
      "the unlock screen",
    );
    await submitRecoveryKey(mounted.host, "RK-wrong");
    await waitFor(
      () =>
        mounted.host.querySelector('[role="alert"]')?.textContent?.includes("doesn't open") ??
        false,
      "the refusal",
    );
    expect(mounted.host.textContent).not.toContain("the app");
    expect((mounted.host.querySelector("input") as HTMLInputElement).value).toBe("");
  });

  it("comes back when the server says the vault locked", async () => {
    const restoreSockets = installFakeSockets();
    try {
      vault = "unlocked";
      saveDeviceToken("tok-me");
      const mounted = await mountForInteraction(gate());
      unmount = mounted.unmount;
      await waitFor(() => mounted.host.textContent === "the app", "the app");
      await waitFor(() => fakeSockets().length > 0, "the events socket");
      const socket = fakeSockets()[0];
      socket?.open();
      socket?.sendJson({
        type: "event",
        seq: 1,
        at: 1,
        deviceId: null,
        kind: "vault.locked",
        data: {},
      });
      await waitFor(
        () => mounted.host.textContent?.includes("vault is locked") ?? false,
        "the unlock screen after a lock",
      );
    } finally {
      restoreSockets();
    }
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
