import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import {
  deviceToken,
  saveDeviceToken,
  serverFetch,
  signOut,
  signOutThisDevice,
} from "../../lib/server";
import { mountForInteraction, waitFor } from "../../test/render";
import { stubServerRoutes } from "../../test/serverRoutes";
import SignInGate from "./SignInGate";

let setupRequired = false;
const server = stubServerRoutes({
  "GET /api/auth/status": () => Response.json({ setupRequired, vault: "absent" }),
  "GET /api/devices/me": () => Response.json({ error: "sign in first" }, { status: 401 }),
  "DELETE /api/devices/me": () => Response.json({ error: "boom" }, { status: 500 }),
  "POST /api/auth/login": () =>
    Response.json({ token: "tok-new", device: { deviceId: "d2", name: "x", scopes: [] } }),
  "POST /api/auth/setup/start": () =>
    Response.json({
      enrollmentId: "e1",
      secret: "JBSWY3DPEHPK3PXP",
      otpauthUri: "otpauth://totp/Yarvis:yarvis-server?secret=JBSWY3DPEHPK3PXP",
      qrSvg: "<svg xmlns='http://www.w3.org/2000/svg'/>",
    }),
  "POST /api/auth/setup/finish": () =>
    Response.json({
      token: "tok-first",
      device: { deviceId: "d1", name: "x", scopes: [] },
      backupCodes: ["AAAAA-BBBBB", "CCCCC-DDDDD"],
    }),
});
afterAll(() => {
  server.restore();
  signOut();
});

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
  setupRequired = false;
  server.calls.length = 0;
});

const gate = () => createElement(SignInGate, null, createElement("p", null, "the app"));

/** Sets an input's value the way React notices. */
function type(input: HTMLInputElement | undefined, value: string) {
  if (!input) throw new Error("no such input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The input under the label that reads `label`. */
const field = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("label")]
    .find((l) => l.querySelector("span")?.textContent === label)
    ?.querySelector("input") ?? undefined;

const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;

async function press(host: HTMLElement, text: string) {
  await waitFor(() => button(host, text)?.disabled === false, `the ${text} button`);
  button(host, text)?.click();
}

describe("SignInGate", () => {
  it("shows the app to a signed-in device, and sign-in once the server rejects it", async () => {
    saveDeviceToken("tok-me");
    const mounted = await mountForInteraction(gate());
    unmount = mounted.unmount;
    await waitFor(() => mounted.host.textContent === "the app", "the app");

    await serverFetch("/api/devices/me");
    await waitFor(() => field(mounted.host, "Passphrase") !== undefined, "the sign-in form");
  });

  it("says the device may still be listed when the server couldn't revoke it", async () => {
    saveDeviceToken("tok-me");
    const mounted = await mountForInteraction(gate());
    unmount = mounted.unmount;
    await waitFor(() => mounted.host.textContent === "the app", "the app");

    await signOutThisDevice();
    await waitFor(() => field(mounted.host, "Passphrase") !== undefined, "the sign-in form");
    expect(mounted.host.querySelector('[role="status"]')?.textContent).toContain(
      "didn't confirm it revoked",
    );
  });

  it("signs in with the passphrase and a code, or a backup code", async () => {
    signOut();
    const mounted = await mountForInteraction(gate());
    unmount = mounted.unmount;
    await waitFor(() => field(mounted.host, "Passphrase") !== undefined, "the sign-in form");
    button(mounted.host, "Use a backup code")?.click();
    await waitFor(() => field(mounted.host, "Backup code") !== undefined, "the backup field");
    type(field(mounted.host, "Passphrase"), "a long passphrase");
    type(field(mounted.host, "Backup code"), " AAAAA-BBBBB ");
    await press(mounted.host, "Sign in");

    await waitFor(() => mounted.host.textContent?.startsWith("the app") ?? false, "the app");
    expect(server.calls.find((c) => c.route === "POST /api/auth/login")?.body).toMatchObject({
      passphrase: "a long passphrase",
      backupCode: "AAAAA-BBBBB",
    });
    expect(await deviceToken()).toBe("tok-new");
  });

  it("walks a new server through setup and shows the backup codes before signing in", async () => {
    signOut();
    setupRequired = true;
    const mounted = await mountForInteraction(gate());
    unmount = mounted.unmount;
    await waitFor(() => field(mounted.host, "Setup code") !== undefined, "the setup form");
    type(field(mounted.host, "Setup code"), "ABCDE-FGHIJ");
    type(field(mounted.host, "Passphrase"), "a long passphrase");
    type(field(mounted.host, "Passphrase again"), "a different one!");
    await waitFor(() => mounted.host.textContent?.includes("don't match") ?? false, "the mismatch");
    expect(button(mounted.host, "Next")?.disabled).toBe(true);
    type(field(mounted.host, "Passphrase again"), "a long passphrase");
    await press(mounted.host, "Next");

    await waitFor(() => mounted.host.querySelector("img") !== null, "the QR code");
    expect(mounted.host.querySelector("img")?.getAttribute("src")).toStartWith(
      "data:image/svg+xml;utf8,",
    );
    expect(mounted.host.textContent).toContain("JBSWY3DPEHPK3PXP");
    type(field(mounted.host, "Code from the app"), "123 456");
    await press(mounted.host, "Confirm");

    await waitFor(
      () => mounted.host.textContent?.includes("CCCCC-DDDDD") ?? false,
      "the backup codes",
    );
    expect(await deviceToken(), "not signed in until the codes are seen").toBeNull();
    expect(server.calls.find((c) => c.route === "POST /api/auth/setup/finish")?.body).toEqual({
      enrollmentId: "e1",
      code: "123456",
    });
    await press(mounted.host, "I've saved them — continue");
    await waitFor(() => mounted.host.textContent?.startsWith("the app") ?? false, "the app");
    expect(await deviceToken()).toBe("tok-first");
  });
});
