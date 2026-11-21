import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { saveDeviceToken, signOut } from "../lib/server";
import { mountForInteraction, waitFor } from "../test/render";
import { stubServerRoutes } from "../test/serverRoutes";
import AccountSection from "./AccountSection";

const server = stubServerRoutes({
  "GET /api/account": () => Response.json({ backupCodesLeft: 7 }),
  "POST /api/account/passphrase": () => Response.json({ revokedDevices: ["d2", "d3"] }),
  "POST /api/account/backup-codes": () => Response.json({ backupCodes: ["NEWAA-CODES"] }),
  "POST /api/account/totp/start": () =>
    Response.json({
      enrollmentId: "e2",
      secret: "NEWSECRET",
      otpauthUri: "otpauth://x",
      qrSvg: "<svg/>",
    }),
  "POST /api/account/totp/finish": () => Response.json({ revokedDevices: [] }),
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
});

function type(input: HTMLInputElement | undefined, value: string) {
  if (!input) throw new Error("no such input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

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

async function mounted() {
  saveDeviceToken("tok-me");
  const m = await mountForInteraction(createElement(AccountSection));
  unmount = m.unmount;
  await waitFor(() => m.host.textContent?.includes("7 backup codes left") ?? false, "the account");
  return m.host;
}

describe("AccountSection", () => {
  it("changes the passphrase, signing out the rest when asked", async () => {
    const host = await mounted();
    (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    type(field(host, "Current passphrase"), "the old passphrase");
    type(field(host, "New passphrase"), "a brand new passphrase");
    await press(host, "Change passphrase");
    await waitFor(() => host.textContent?.includes("2 other devices signed out") ?? false, "done");
    expect(server.calls.find((c) => c.route === "POST /api/account/passphrase")?.body).toEqual({
      currentPassphrase: "the old passphrase",
      newPassphrase: "a brand new passphrase",
      signOutOtherDevices: true,
    });
  });

  it("shows new backup codes once", async () => {
    const host = await mounted();
    await press(host, "Make new backup codes");
    await waitFor(() => host.textContent?.includes("NEWAA-CODES") ?? false, "the codes");
    await press(host, "Done");
    await waitFor(() => !(host.textContent?.includes("NEWAA-CODES") ?? true), "them hidden");
  });

  it("confirms a new authenticator with a code from it", async () => {
    const host = await mounted();
    await press(host, "Set up a new authenticator");
    await waitFor(() => host.textContent?.includes("NEWSECRET") ?? false, "the new secret");
    type(field(host, "Code from the app"), "111222");
    await press(host, "Confirm");
    await waitFor(() => host.textContent?.includes("new authenticator is in use") ?? false, "done");
    expect(server.calls.find((c) => c.route === "POST /api/account/totp/finish")?.body).toEqual({
      enrollmentId: "e2",
      code: "111222",
      signOutOtherDevices: false,
    });
  });
});
