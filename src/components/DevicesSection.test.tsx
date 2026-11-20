import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { Device } from "../lib/auth";
import { saveDeviceToken, signOut } from "../lib/server";
import { clipboardWrites, resetClipboardWrites } from "../test/clipboard";
import { mountForInteraction, waitFor } from "../test/render";
import { stubServerRoutes } from "../test/serverRoutes";
import DevicesSection from "./DevicesSection";

const me: Device = {
  id: "d-me",
  name: "Chrome on Mac",
  kind: "passkey",
  scopes: ["read", "chat", "approve", "admin"],
};
let devices: Device[] = [];
let current: Device = me;

const server = stubServerRoutes({
  "GET /api/devices/me": () => Response.json(current),
  "GET /api/devices": () => Response.json(devices),
  "POST /api/devices/tokens": (body) => {
    const { name, scopes } = body as { name: string; scopes: Device["scopes"] };
    const device: Device = { id: "d-new", name, kind: "token", scopes };
    devices = [...devices, device];
    return Response.json({ token: "yv_secret_once", device });
  },
  "DELETE /api/devices/d-phone": () => {
    devices = devices.filter((d) => d.id !== "d-phone");
    return new Response(null, { status: 204 });
  },
});

beforeAll(() => saveDeviceToken("tok-me"));
afterAll(() => {
  server.restore();
  signOut();
});

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
  server.calls.length = 0;
  current = me;
  resetClipboardWrites();
});

const buttonNamed = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("DevicesSection", () => {
  it("lists the devices and revokes one", async () => {
    devices = [
      me,
      { id: "d-phone", name: "Phone", kind: "passkey", scopes: ["read"], lastSeenAt: null },
    ];
    const mounted = await mountForInteraction(createElement(DevicesSection));
    unmount = mounted.unmount;
    await waitFor(() => mounted.host.textContent?.includes("Phone") ?? false, "the device list");
    expect(mounted.host.textContent).toContain("this device");

    const rows = [...mounted.host.querySelectorAll("li")];
    const phoneRow = rows.find((li) => li.textContent?.includes("Phone"));
    phoneRow?.querySelector("button")?.click();

    await waitFor(
      () => !(mounted.host.textContent?.includes("Phone") ?? true),
      "the revoked device to go",
    );
    expect(server.calls.map((c) => c.route)).toContain("DELETE /api/devices/d-phone");
  });

  it("mints a token with the chosen scopes and shows it once", async () => {
    devices = [me];
    const mounted = await mountForInteraction(createElement(DevicesSection));
    unmount = mounted.unmount;
    await waitFor(() => buttonNamed(mounted.host, "Create token") !== undefined, "the token form");

    type(
      mounted.host.querySelector('input[placeholder="Work laptop"]') as HTMLInputElement,
      "CI bot",
    );
    buttonNamed(mounted.host, "Create token")?.click();

    await waitFor(() => mounted.host.textContent?.includes("yv_secret_once") ?? false, "the token");
    expect(server.calls.find((c) => c.route === "POST /api/devices/tokens")?.body).toEqual({
      name: "CI bot",
      scopes: ["read", "chat"],
    });
    buttonNamed(mounted.host, "Copy")?.click();
    await waitFor(() => clipboardWrites().length === 1, "the copy");
    expect(clipboardWrites()).toEqual(["yv_secret_once"]);

    buttonNamed(mounted.host, "Done")?.click();
    await waitFor(
      () => !(mounted.host.textContent?.includes("yv_secret_once") ?? true),
      "the token to go",
    );
  });

  it("explains, rather than lists, for a device without the admin scope", async () => {
    current = { ...me, scopes: ["read"] };
    const mounted = await mountForInteraction(createElement(DevicesSection));
    unmount = mounted.unmount;
    await waitFor(
      () => mounted.host.textContent?.includes("needs the admin scope") ?? false,
      "the notice",
    );
    expect(server.calls.map((c) => c.route)).not.toContain("GET /api/devices");
  });
});
