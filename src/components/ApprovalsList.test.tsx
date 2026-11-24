import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { Approval } from "../lib/auth";
import { saveDeviceToken, signOut } from "../lib/server";
import { fakeSockets, installFakeSockets } from "../test/fakeSocket";
import { mountForInteraction, renderToHtml, waitFor } from "../test/render";
import { stubServerRoutes } from "../test/serverRoutes";
import ApprovalsList from "./ApprovalsList";

let approvals: Approval[] = [];
let answerStatus = 204;
let grantExpiresAt: number | undefined;

const server = stubServerRoutes({
  "GET /api/approvals": () => Response.json(approvals),
  "POST /api/approvals/ap-1": (body) => {
    approvals = [];
    const allowFor = (body as { allowForSecs?: number }).allowForSecs;
    if (allowFor !== undefined) grantExpiresAt = Date.now() + allowFor * 1000;
    return answerStatus === 204
      ? new Response(null, { status: 204 })
      : Response.json({ error: "already answered" }, { status: answerStatus });
  },
  "GET /api/vault/ssh-agent": () => Response.json({ enabled: true, grantExpiresAt }),
  "DELETE /api/vault/ssh-agent/grant": () => {
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
    expect(buttonNamed(mounted.host, "5 min")).toBeDefined();
    expect(buttonNamed(mounted.host, "1 hour")).toBeUndefined();
  });

  it("offers no durations on an approval that covers only itself", async () => {
    approvals = [signing];
    const mounted = await mountForInteraction(createElement(ApprovalsList));
    unmount = mounted.unmount;
    await waitFor(() => buttonNamed(mounted.host, "Approve") !== undefined, "the request");
    expect(buttonNamed(mounted.host, "5 min")).toBeUndefined();
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

    buttonNamed(mounted.host, "Stop")?.click();

    // Nothing waits and nothing is allowed, so the shell's copy goes away.
    await waitFor(() => mounted.host.innerHTML === "", "the grant to end");
    expect(server.calls.some((c) => c.route === "DELETE /api/vault/ssh-agent/grant")).toBe(true);
  });

  it("shows nothing about signing once the grant has run out", async () => {
    approvals = [];
    grantExpiresAt = Date.now() - 1_000;
    const mounted = await mountForInteraction(createElement(ApprovalsList));
    unmount = mounted.unmount;
    await waitFor(
      () => mounted.host.textContent?.includes("Nothing is waiting") ?? false,
      "the empty list",
    );
    expect(mounted.host.textContent).not.toContain("without asking");
  });
});
