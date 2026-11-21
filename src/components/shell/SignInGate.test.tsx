import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { saveDeviceToken, serverFetch, signOut } from "../../lib/server";
import { mountForInteraction, waitFor } from "../../test/render";
import { stubServerRoutes } from "../../test/serverRoutes";
import SignInGate from "./SignInGate";

let setupRequired = false;
const server = stubServerRoutes({
  "GET /api/auth/status": () =>
    Response.json({ setupRequired, rpId: "localhost", vault: "absent" }),
  "GET /api/devices/me": () => Response.json({ error: "sign in first" }, { status: 401 }),
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
});

const gate = () => createElement(SignInGate, null, createElement("p", null, "the app"));

describe("SignInGate", () => {
  it("shows the app to a signed-in device, and sign-in once the server rejects it", async () => {
    saveDeviceToken("tok-me");
    const mounted = await mountForInteraction(gate());
    unmount = mounted.unmount;
    await waitFor(() => mounted.host.textContent === "the app", "the app");

    await serverFetch("/api/devices/me");

    // Enabled once the server's status has arrived, so no request is left in flight.
    await waitFor(
      () =>
        mounted.host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled === false,
      "the sign-in form",
    );
    expect(mounted.host.textContent).toContain("Sign in with your passkey");
  });

  it("asks for the setup code on a server nobody has set up", async () => {
    signOut();
    setupRequired = true;
    const mounted = await mountForInteraction(gate());
    unmount = mounted.unmount;
    await waitFor(
      () => mounted.host.textContent?.includes("Setup code") ?? false,
      "the setup form",
    );
    expect(mounted.host.textContent).toContain("Create passkey");
    expect(mounted.host.textContent).not.toContain("the app");
  });
});
