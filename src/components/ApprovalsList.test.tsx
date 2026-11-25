import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { Approval } from "../lib/auth";
import { primeCache } from "../lib/resourceCache";
import { saveDeviceToken, signOut } from "../lib/server";
import { fakeSockets, installFakeSockets } from "../test/fakeSocket";
import { mountForInteraction, renderToHtml, waitFor } from "../test/render";
import { stubServerRoutes } from "../test/serverRoutes";
import ApprovalsList from "./ApprovalsList";

let approvals: Approval[] = [];
let answerStatus = 204;
let grantExpiresAt: number | undefined;
let stopFails = false;
let statusFails = false;
/** Set to hold the next Stop until the test resolves it. */
let stopHeld: Promise<void> | undefined;
let serverClockOffsetMs = 0;

const server = stubServerRoutes({
  "GET /api/approvals": () => Response.json(approvals),
  "GET /api/devices/me": () =>
    Response.json({ deviceId: "dev-me", name: "This Mac", scopes: ["read", "approve"] }),
  "POST /api/approvals/ap-1": (body) => {
    approvals = [];
    const allowFor = (body as { allowForSecs?: number }).allowForSecs;
    if (allowFor !== undefined) grantExpiresAt = Date.now() + allowFor * 1000;
    return answerStatus === 204
      ? new Response(null, { status: 204 })
      : Response.json({ error: "already answered" }, { status: answerStatus });
  },
  // As the server does: an active grant comes with its time left, and one
  // that has run out isn't reported. `serverClockOffsetMs` moves the server's
  // clock away from this device's.
  "GET /api/vault/ssh-agent": () => {
    if (statusFails) return Response.json({ error: "agent unreachable" }, { status: 500 });
    const left = grantExpiresAt === undefined ? 0 : grantExpiresAt - Date.now();
    return Response.json(
      left > 0
        ? {
            enabled: true,
            grantExpiresAt: (grantExpiresAt ?? 0) + serverClockOffsetMs,
            grantRemainingMs: left,
          }
        : { enabled: true },
    );
  },
  "DELETE /api/vault/ssh-agent/grant": async () => {
    await stopHeld;
    if (stopFails) return Response.json({ error: "vault unreachable" }, { status: 500 });
    grantExpiresAt = undefined;
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
  answerStatus = 204;
  grantExpiresAt = undefined;
  stopFails = false;
  statusFails = false;
  stopHeld = undefined;
  serverClockOffsetMs = 0;
});

const signing: Approval = {
  id: "ap-1",
  kind: "git.sign",
  summary: "Sign with SHA256:abc (sha512)",
  data: { keyFingerprint: "SHA256:abc", hashAlgorithm: "sha512" },
  createdAt: 1_763_600_000_000,
  expiresAt: 1_763_600_060_000,
};

const buttonNamed = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;

const customMinutesField = (host: HTMLElement) =>
  host.querySelector<HTMLInputElement>('input[aria-label="Custom minutes"]');

/** Types into the custom minutes field the way React sees a keystroke. */
const typeMinutes = async (host: HTMLElement, text: string) => {
  const field = customMinutesField(host);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, text);
  field?.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(() => customMinutesField(host)?.value === text, `the field to read ${text}`);
};

describe("ApprovalsList", () => {
  it("renders nothing in the shell while nothing waits", async () => {
    approvals = [];
    expect(await renderToHtml(createElement(ApprovalsList, { hideWhenEmpty: true }))).toBe("");
  });

  it("approves a pending request and drops it from the list", async () => {
    approvals = [signing];
    const mounted = await mountForInteraction(
      createElement(ApprovalsList, { hideWhenEmpty: true }),
    );
    unmount = mounted.unmount;
    await waitFor(
      () => mounted.host.textContent?.includes("Sign with SHA256:abc") ?? false,
      "the request",
    );

    buttonNamed(mounted.host, "Approve")?.click();

    await waitFor(() => mounted.host.innerHTML === "", "the list to empty");
    expect(server.calls.find((c) => c.route === "POST /api/approvals/ap-1")?.body).toEqual({
      approve: true,
    });
  });

  it("shows a request as soon as the server announces it", async () => {
    const restoreSockets = installFakeSockets();
    try {
      approvals = [];
      const mounted = await mountForInteraction(createElement(ApprovalsList));
      unmount = mounted.unmount;
      await waitFor(() => fakeSockets().length > 0, "the events socket");
      await waitFor(
        () => mounted.host.textContent?.includes("Nothing is waiting") ?? false,
        "the empty list",
      );
      const socket = fakeSockets()[0];
      socket?.open();

      approvals = [signing];
      socket?.sendJson({
        type: "event",
        seq: 1,
        at: 1,
        deviceId: null,
        kind: "approval.requested",
        data: {},
      });

      await waitFor(
        () => mounted.host.textContent?.includes("Sign with SHA256:abc") ?? false,
        "the request",
      );
    } finally {
      unmount?.();
      unmount = undefined;
      restoreSockets();
    }
  });

  it("treats a 409 as another device having answered, not as an error", async () => {
    approvals = [signing];
    answerStatus = 409;
    const mounted = await mountForInteraction(createElement(ApprovalsList));
    unmount = mounted.unmount;
    await waitFor(() => buttonNamed(mounted.host, "Deny") !== undefined, "the request");

    buttonNamed(mounted.host, "Deny")?.click();

    await waitFor(
      () => mounted.host.textContent?.includes("Nothing is waiting") ?? false,
      "the reload",
    );
    expect(mounted.host.querySelector('[role="alert"]')).toBeNull();
  });

  it("offers durations only up to what the approval allows", async () => {
    approvals = [{ ...signing, maxAllowForSecs: 15 * 60 }];
    const mounted = await mountForInteraction(createElement(ApprovalsList));
    unmount = mounted.unmount;
    await waitFor(() => buttonNamed(mounted.host, "15 min") !== undefined, "the durations");
    expect(buttonNamed(mounted.host, "30 min")).toBeUndefined();
    expect(buttonNamed(mounted.host, "1 hour")).toBeUndefined();
  });

  it("offers durations on the approval that allows them and not on one that doesn't", async () => {
    approvals = [
      { ...signing, maxAllowForSecs: 60 * 60 },
      { ...signing, id: "ap-2", summary: "Covers only itself" },
    ];
    const mounted = await mountForInteraction(createElement(ApprovalsList));
    unmount = mounted.unmount;
    await waitFor(() => buttonNamed(mounted.host, "1 hour") !== undefined, "the durations");
    const [offering, plain] = [...mounted.host.querySelectorAll("li")];
    expect(offering?.textContent).toContain("Approve and stop asking for");
    expect(plain?.textContent).toContain("Covers only itself");
    expect(plain?.textContent).not.toContain("Approve and stop asking for");
  });

  it("sends each duration in seconds", async () => {
    approvals = [{ ...signing, maxAllowForSecs: 60 * 60 }];
    const mounted = await mountForInteraction(createElement(ApprovalsList));
    unmount = mounted.unmount;
    await waitFor(() => buttonNamed(mounted.host, "30 min") !== undefined, "the durations");

    buttonNamed(mounted.host, "30 min")?.click();

    await waitFor(
      () => server.calls.some((c) => c.route === "POST /api/approvals/ap-1"),
      "the answer",
    );
    expect(server.calls.find((c) => c.route === "POST /api/approvals/ap-1")?.body).toEqual({
      approve: true,
      allowForSecs: 1800,
    });
    await waitFor(() => mounted.host.textContent?.includes("without asking") ?? false, "the grant");
  });

  it("sends a custom number of minutes in seconds", async () => {
    approvals = [{ ...signing, maxAllowForSecs: 60 * 60 }];
    const mounted = await mountForInteraction(createElement(ApprovalsList));
    unmount = mounted.unmount;
    await waitFor(() => customMinutesField(mounted.host) !== null, "the custom field");

    await typeMinutes(mounted.host, "20");
    buttonNamed(mounted.host, "Allow")?.click();

    await waitFor(
      () => server.calls.some((c) => c.route === "POST /api/approvals/ap-1"),
      "the answer",
    );
    expect(server.calls.find((c) => c.route === "POST /api/approvals/ap-1")?.body).toEqual({
      approve: true,
      allowForSecs: 1200,
    });
    await waitFor(() => mounted.host.textContent?.includes("without asking") ?? false, "the grant");
  });

  it("won't send a custom time the approval doesn't allow", async () => {
    approvals = [{ ...signing, maxAllowForSecs: 15 * 60 }];
    const mounted = await mountForInteraction(createElement(ApprovalsList));
    unmount = mounted.unmount;
    await waitFor(() => customMinutesField(mounted.host) !== null, "the custom field");
    expect(buttonNamed(mounted.host, "Allow")?.disabled).toBe(true);

    for (const typed of ["16", "0", "2.5"]) {
      await typeMinutes(mounted.host, typed);
      expect(buttonNamed(mounted.host, "Allow")?.disabled).toBe(true);
    }
    await typeMinutes(mounted.host, "15");
    expect(buttonNamed(mounted.host, "Allow")?.disabled).toBe(false);
    expect(server.calls.some((c) => c.route === "POST /api/approvals/ap-1")).toBe(false);
  });

  it("approves for a while, shows until when, and stops on request", async () => {
    approvals = [{ ...signing, maxAllowForSecs: 60 * 60 }];
    const mounted = await mountForInteraction(
      createElement(ApprovalsList, { hideWhenEmpty: true }),
    );
    unmount = mounted.unmount;
    await waitFor(() => buttonNamed(mounted.host, "15 min") !== undefined, "the durations");

    buttonNamed(mounted.host, "15 min")?.click();

    await waitFor(
      () => mounted.host.textContent?.includes("Signing commits without asking until") ?? false,
      "the grant",
    );
    expect(server.calls.find((c) => c.route === "POST /api/approvals/ap-1")?.body).toEqual({
      approve: true,
      allowForSecs: 900,
    });
    // An active grant is something to show, so the box isn't "empty".
    expect(mounted.host.textContent).not.toContain("Nothing is waiting");

    buttonNamed(mounted.host, "Stop")?.click();

    // Nothing waits and nothing is allowed, so the shell's copy goes away.
    await waitFor(() => mounted.host.innerHTML === "", "the grant to end");
    expect(server.calls.some((c) => c.route === "DELETE /api/vault/ssh-agent/grant")).toBe(true);
  });

  it("drops the banner when the grant runs out while it's shown", async () => {
    approvals = [];
    grantExpiresAt = Date.now() + 1_500;
    const mounted = await mountForInteraction(
      createElement(ApprovalsList, { hideWhenEmpty: true }),
    );
    unmount = mounted.unmount;
    await waitFor(
      () => mounted.host.textContent?.includes("without asking") ?? false,
      "the banner",
    );
    // No refetch moves it: the component's own timer does.
    await waitFor(() => mounted.host.innerHTML === "", "the banner to go at expiry");
  });

  it("drops the banner when the server says the vault locked", async () => {
    const restoreSockets = installFakeSockets();
    try {
      approvals = [];
      grantExpiresAt = Date.now() + 600_000;
      const mounted = await mountForInteraction(createElement(ApprovalsList));
      unmount = mounted.unmount;
      await waitFor(() => fakeSockets().length > 0, "the events socket");
      await waitFor(
        () => mounted.host.textContent?.includes("without asking") ?? false,
        "the banner",
      );
      const socket = fakeSockets()[0];
      socket?.open();

      grantExpiresAt = undefined;
      socket?.sendJson({
        type: "event",
        seq: 2, // The stream skips a seq it has already seen in this file.
        at: 1,
        deviceId: null,
        kind: "vault.locked",
        data: {},
      });

      await waitFor(
        () => !(mounted.host.textContent?.includes("without asking") ?? true),
        "the banner to go",
      );
    } finally {
      unmount?.();
      unmount = undefined;
      restoreSockets();
    }
  });

  it("offers durations again, with no banner, once a grant has run out", async () => {
    approvals = [{ ...signing, maxAllowForSecs: 60 * 60 }];
    grantExpiresAt = Date.now() - 1_000;
    const mounted = await mountForInteraction(createElement(ApprovalsList));
    unmount = mounted.unmount;
    await waitFor(() => buttonNamed(mounted.host, "15 min") !== undefined, "the durations");
    expect(mounted.host.textContent).not.toContain("without asking");
  });

  it("keeps the banner up when this device's clock runs ahead of the server's", async () => {
    approvals = [];
    grantExpiresAt = Date.now() + 600_000;
    // The server's clock is an hour behind, so its end time is already past
    // by this device's clock. The time left is what counts.
    serverClockOffsetMs = -3_600_000;
    const mounted = await mountForInteraction(
      createElement(ApprovalsList, { hideWhenEmpty: true }),
    );
    unmount = mounted.unmount;
    await waitFor(() => buttonNamed(mounted.host, "Stop") !== undefined, "the banner");
  });

  it("says so when Stop fails, and keeps the banner", async () => {
    approvals = [];
    grantExpiresAt = Date.now() + 600_000;
    stopFails = true;
    const mounted = await mountForInteraction(createElement(ApprovalsList));
    unmount = mounted.unmount;
    await waitFor(() => buttonNamed(mounted.host, "Stop") !== undefined, "the banner");

    buttonNamed(mounted.host, "Stop")?.click();

    await waitFor(() => mounted.host.querySelector('[role="alert"]') !== null, "the error");
    // The refetch after the failure still shows the grant the server has.
    await waitFor(
      () => server.calls.filter((c) => c.route === "GET /api/vault/ssh-agent").length > 1,
      "the refetch",
    );
    expect(mounted.host.textContent).toContain("without asking");
  });

  it("keeps Stop disabled while it runs, so a second press sends nothing", async () => {
    approvals = [];
    grantExpiresAt = Date.now() + 600_000;
    let release = () => {};
    stopHeld = new Promise((resolve) => {
      release = resolve;
    });
    const mounted = await mountForInteraction(createElement(ApprovalsList));
    unmount = mounted.unmount;
    await waitFor(() => buttonNamed(mounted.host, "Stop") !== undefined, "the banner");

    buttonNamed(mounted.host, "Stop")?.click();
    await waitFor(() => buttonNamed(mounted.host, "Stop")?.disabled ?? false, "Stop to disable");
    buttonNamed(mounted.host, "Stop")?.click();
    release();

    await waitFor(
      () => !(mounted.host.textContent?.includes("without asking") ?? true),
      "the grant to end",
    );
    expect(
      server.calls.filter((c) => c.route === "DELETE /api/vault/ssh-agent/grant"),
    ).toHaveLength(1);
  });

  it("says so when the agent's status can't be read", async () => {
    approvals = [];
    statusFails = true;
    const mounted = await mountForInteraction(createElement(ApprovalsList));
    unmount = mounted.unmount;
    await waitFor(
      () =>
        mounted.host.querySelector('[role="alert"]')?.textContent?.includes("agent unreachable") ??
        false,
      "the error",
    );
  });

  it("shows the banner without Stop on a device that can't approve", async () => {
    approvals = [];
    grantExpiresAt = Date.now() + 600_000;
    // Known before the first render, so the banner can't show with Stop on it.
    primeCache("server:devices:me", { deviceId: "dev-me", name: "Watcher", scopes: ["read"] });
    const mounted = await mountForInteraction(createElement(ApprovalsList));
    unmount = mounted.unmount;
    await waitFor(
      () => mounted.host.textContent?.includes("without asking") ?? false,
      "the banner",
    );
    expect(buttonNamed(mounted.host, "Stop")).toBeUndefined();
  });
});
