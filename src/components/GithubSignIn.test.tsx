import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { DeviceFlowStatus } from "../lib/githubAuth";
import { mountForInteraction, renderToHtml } from "../test/render";
import { GithubSignIn } from "./GithubSignIn";

let configured = true;
let outcome: DeviceFlowStatus = { state: "authorized", login: "octocat" };
let cancelled: string[] = [];

mock.module("../lib/githubAuth", () => ({
  githubSignInConfigured: async () => configured,
  startGithubSignIn: async () => ({
    id: "flow-1",
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresAt: "2026-10-18T12:15:00Z",
  }),
  fetchGithubSignInStatus: async () => outcome,
  cancelGithubSignIn: async (id: string) => {
    cancelled.push(id);
  },
}));

/** Past the component's 2s status poll. */
const AFTER_ONE_POLL_MS = 2200;

function click(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!button) throw new Error(`no "${label}" button`);
  button.click();
}

describe("GithubSignIn", () => {
  let unmount: () => void = () => {};

  beforeEach(() => {
    configured = true;
    outcome = { state: "authorized", login: "octocat" };
    cancelled = [];
  });

  afterEach(() => unmount());

  it("hides the button in a build with no OAuth App", async () => {
    configured = false;
    expect(await renderToHtml(<GithubSignIn onSignedIn={async () => {}} />)).toBe("");
  });

  it("shows the code, then restarts the sidecar once GitHub says yes", async () => {
    let restarts = 0;
    const mounted = await mountForInteraction(
      <GithubSignIn
        onSignedIn={async () => {
          restarts++;
        }}
      />,
    );
    unmount = mounted.unmount;

    click(mounted.host, "Sign in with GitHub");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mounted.host.textContent).toContain("ABCD-1234");

    await new Promise((resolve) => setTimeout(resolve, AFTER_ONE_POLL_MS));
    expect(restarts).toBe(1);
    expect(mounted.host.textContent).toContain("Signed in to GitHub as octocat.");
  });

  it("says so when the restart after signing in fails", async () => {
    const mounted = await mountForInteraction(
      <GithubSignIn
        onSignedIn={async () => {
          throw new Error("sidecar didn't come back");
        }}
      />,
    );
    unmount = mounted.unmount;

    click(mounted.host, "Sign in with GitHub");
    await new Promise((resolve) => setTimeout(resolve, AFTER_ONE_POLL_MS + 50));
    expect(mounted.host.textContent).toContain("restarting the sidecar failed");
  });

  it("cancels the sign-in when the user backs out", async () => {
    outcome = { state: "pending", userCode: "x", verificationUri: "x", expiresAt: "x" };
    const mounted = await mountForInteraction(<GithubSignIn onSignedIn={async () => {}} />);
    unmount = mounted.unmount;

    click(mounted.host, "Sign in with GitHub");
    await new Promise((resolve) => setTimeout(resolve, 50));
    click(mounted.host, "Cancel");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cancelled).toEqual(["flow-1"]);
    expect(mounted.host.textContent).toContain("Sign in with GitHub");
  });
});
