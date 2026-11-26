import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement, useEffect, useState } from "react";
import { deviceToken, saveDeviceToken, signOut } from "../../lib/server";
import { onServerEvent } from "../../lib/serverEvents";
import { fakeSockets, installFakeSockets } from "../../test/fakeSocket";
import { mountForInteraction, waitFor } from "../../test/render";
import { stubServerRoutes } from "../../test/serverRoutes";
import VaultGate from "./VaultGate";

let vault = "locked";
let recoveryKeyIsRight = true;
let passphraseAnswer: "right" | "wrong" | "wait" = "right";
const server = stubServerRoutes({
  "POST /api/vault/unlock": () => {
    if (passphraseAnswer === "wrong") {
      return Response.json({ error: "that doesn't open the vault" }, { status: 403 });
    }
    if (passphraseAnswer === "wait") {
      return Response.json(
        { error: "wait before trying again", detail: "4s left" },
        { status: 429 },
      );
    }
    vault = "unlocked";
    return Response.json({ state: "unlocked" });
  },
  "GET /api/auth/status": () =>
    vault === "unreachable"
      ? Response.json({ error: "starting" }, { status: 503 })
      : Response.json({ setupRequired: false, vault }),
  "POST /api/vault/unlock/recovery": () => {
    if (!recoveryKeyIsRight) {
      return Response.json({ error: "that doesn't open the vault" }, { status: 403 });
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
  passphraseAnswer = "right";
});

const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;

async function submit(host: HTMLElement, secret: string, { recovery }: { recovery: boolean }) {
  if (recovery) button(host, "Use the recovery key").click();
  await waitFor(
    () => host.textContent?.includes(recovery ? "Recovery key" : "Vault passphrase") ?? false,
    "the field",
  );
  type(host.querySelector("input") as HTMLInputElement, secret);
  await waitFor(() => !button(host, "Unlock").disabled, "the unlock button");
  button(host, "Unlock").click();
}

/** Stands in for the app, and says when it has seen the vault lock. */
function SeesLock() {
  const [seen, setSeen] = useState(false);
  useEffect(() => onServerEvent("vault.locked", () => setSeen(true)), []);
  return createElement("p", null, seen ? "the app, lock seen" : "the app");
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

  it("holds the app until the vault's own passphrase opens it", async () => {
    saveDeviceToken("tok-me");
    const mounted = await mountForInteraction(gate());
    unmount = mounted.unmount;
    await waitFor(
      () => mounted.host.textContent?.includes("vault is locked") ?? false,
      "the unlock screen",
    );
    expect(mounted.host.textContent).toContain("not your sign-in one");
    expect(mounted.host.textContent).not.toContain("the app");

    await submit(mounted.host, "the vault's passphrase", { recovery: false });

    await waitFor(() => mounted.host.textContent === "the app", "the app after unlock");
    expect(server.calls.find((c) => c.route === "POST /api/vault/unlock")?.body).toEqual({
      passphrase: "the vault's passphrase",
    });
  });

  it("falls back to the recovery key", async () => {
    saveDeviceToken("tok-me");
    const mounted = await mountForInteraction(gate());
    unmount = mounted.unmount;
    await waitFor(
      () => mounted.host.textContent?.includes("vault is locked") ?? false,
      "the unlock screen",
    );
    await submit(mounted.host, " RK-1234 ", { recovery: true });

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
    await submit(mounted.host, "RK-wrong", { recovery: true });
    await waitFor(
      () =>
        mounted.host.querySelector('[role="alert"]')?.textContent?.includes("doesn't open") ??
        false,
      "the refusal",
    );
    expect(mounted.host.textContent).not.toContain("the app");
    expect((mounted.host.querySelector("input") as HTMLInputElement).value).toBe("");
    expect(await deviceToken()).toBe("tok-me");
  });

  for (const [answer, shown] of [
    ["wrong", "doesn't open"],
    ["wait", "wait before trying again"],
  ] as const) {
    it(`keeps the device signed in when the server answers ${answer} to a passphrase`, async () => {
      passphraseAnswer = answer;
      saveDeviceToken("tok-me");
      const mounted = await mountForInteraction(gate());
      unmount = mounted.unmount;
      await waitFor(
        () => mounted.host.textContent?.includes("vault is locked") ?? false,
        "the unlock screen",
      );
      await submit(mounted.host, "a guess", { recovery: false });
      await waitFor(
        () => mounted.host.querySelector('[role="alert"]')?.textContent?.includes(shown) ?? false,
        "the refusal",
      );
      expect(mounted.host.textContent).toContain("vault is locked");
      expect(await deviceToken()).toBe("tok-me");
    });
  }

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

  it("stays open when a vault holding only the signing key locks", async () => {
    const restoreSockets = installFakeSockets();
    try {
      vault = "absent";
      saveDeviceToken("tok-me");
      const mounted = await mountForInteraction(
        createElement(VaultGate, null, createElement(SeesLock)),
      );
      unmount = mounted.unmount;
      await waitFor(() => mounted.host.textContent === "the app", "the app");
      await waitFor(() => fakeSockets().length > 0, "the events socket");
      const socket = fakeSockets()[0];
      socket?.open();
      socket?.sendJson({
        type: "event",
        seq: 2,
        at: 1,
        deviceId: null,
        kind: "vault.locked",
        data: {},
      });
      // The child's update lands in the same render as any the gate makes,
      // so its text only shows if the gate kept it mounted.
      await waitFor(
        () => mounted.host.textContent === "the app, lock seen",
        "the app to stay open after the lock",
      );
    } finally {
      restoreSockets();
    }
  });

  it("still gates on a lock after its first status check failed", async () => {
    const restoreSockets = installFakeSockets();
    try {
      vault = "unreachable";
      saveDeviceToken("tok-me");
      const mounted = await mountForInteraction(gate());
      unmount = mounted.unmount;
      await waitFor(() => mounted.host.textContent === "the app", "the app");
      await waitFor(() => fakeSockets().length > 0, "the events socket");
      const socket = fakeSockets()[0];
      socket?.open();
      socket?.sendJson({
        type: "event",
        seq: 4,
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
