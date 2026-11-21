import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { SidecarError } from "../../lib/api";
import { withFreshCode } from "../../lib/auth";
import { saveDeviceToken, signOut } from "../../lib/server";
import { mountForInteraction, waitFor } from "../../test/render";
import { stubServerRoutes } from "../../test/serverRoutes";
import CodePrompt from "./CodePrompt";

const server = stubServerRoutes({
  "POST /api/auth/reverify": () => Response.json({ verifiedAt: 1 }),
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

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** An action the server refuses for want of a recent code, then allows. */
function needsAFreshCode() {
  let tries = 0;
  return async () => {
    if (++tries === 1) throw new SidecarError("create token failed (403): reauth_required", 403);
    return `done after ${tries} tries`;
  };
}

const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;

describe("CodePrompt", () => {
  it("asks for a code when the server wants one, checks it, and retries the action", async () => {
    saveDeviceToken("tok-me");
    const mounted = await mountForInteraction(createElement(CodePrompt));
    unmount = mounted.unmount;
    const result = withFreshCode(needsAFreshCode());

    await waitFor(() => mounted.host.querySelector('[role="dialog"]') !== null, "the prompt");
    type(mounted.host.querySelector("input") as HTMLInputElement, "654 321");
    await waitFor(() => !button(mounted.host, "Confirm").disabled, "the confirm button");
    button(mounted.host, "Confirm").click();

    expect(await result).toBe("done after 2 tries");
    expect(server.calls.find((c) => c.route === "POST /api/auth/reverify")?.body).toEqual({
      code: "654321",
    });
    await waitFor(() => mounted.host.querySelector('[role="dialog"]') === null, "it to close");
  });

  it("fails the action without retrying when cancelled", async () => {
    saveDeviceToken("tok-me");
    const mounted = await mountForInteraction(createElement(CodePrompt));
    unmount = mounted.unmount;
    const result = withFreshCode(needsAFreshCode());
    await waitFor(() => mounted.host.querySelector('[role="dialog"]') !== null, "the prompt");
    button(mounted.host, "Cancel").click();
    await expect(result).rejects.toThrow("reauth_required");
    expect(server.calls).toHaveLength(0);
  });
});
