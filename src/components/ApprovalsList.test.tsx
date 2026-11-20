import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { Approval } from "../lib/auth";
import { saveDeviceToken, signOut } from "../lib/server";
import { mountForInteraction, renderToHtml, waitFor } from "../test/render";
import { stubServerRoutes } from "../test/serverRoutes";
import ApprovalsList from "./ApprovalsList";

let approvals: Approval[] = [];
let answerStatus = 204;

const server = stubServerRoutes({
  "GET /api/approvals": () => Response.json(approvals),
  "POST /api/approvals/ap-1": () => {
    approvals = [];
    return answerStatus === 204
      ? new Response(null, { status: 204 })
      : Response.json({ error: "already answered" }, { status: answerStatus });
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
});

const signing: Approval = {
  id: "ap-1",
  kind: "ssh.sign",
  summary: "Sign a commit in yarvis",
  status: "pending",
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
      () => mounted.host.textContent?.includes("Sign a commit") ?? false,
      "the request",
    );

    buttonNamed(mounted.host, "Approve")?.click();

    await waitFor(() => mounted.host.innerHTML === "", "the list to empty");
    expect(server.calls.find((c) => c.route === "POST /api/approvals/ap-1")?.body).toEqual({
      approve: true,
    });
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
});
