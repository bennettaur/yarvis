import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import type { PermissionDecision, PermissionRequest } from "../../lib/attention";
import * as attention from "../../lib/attention";
import { mountForInteraction } from "../../test/render";
import PermissionRequestModal from "./PermissionRequestModal";

const REQUEST: PermissionRequest = {
  id: "req-1",
  sessionKey: "ws:w1/t1/p1",
  workspaceId: "w1",
  workspaceName: "Fix the API",
  toolName: "Bash",
  toolInput: { command: "rm -rf build", description: "Clean the build output" },
  cwd: "/Users/me/ws/fix-the-api",
  permissionMode: "default",
  lastReply: "The build folder is stale, so I'll clear it first.",
  lastPrompt: "rebuild the client",
  createdAt: new Date().toISOString(),
};

/** Past the modal's arming delay, so a click lands. */
const armed = () => new Promise((resolve) => setTimeout(resolve, 500));

let queue: PermissionRequest[] = [];
// False when the request was gone by the time the answer reached the sidecar.
let delivers = true;
const decisions: [string, PermissionDecision][] = [];
const spies = [
  spyOn(attention, "getPermissionRequests").mockImplementation(async () => queue),
  spyOn(attention, "decidePermission").mockImplementation(async (id, decision) => {
    decisions.push([id, decision]);
    queue = queue.filter((r) => r.id !== id);
    return delivers;
  }),
];

let unmount: (() => void) | null = null;
let closed = 0;
let wentToSession = 0;

afterEach(() => {
  unmount?.();
  unmount = null;
  queue = [];
  delivers = true;
  decisions.length = 0;
  closed = 0;
  wentToSession = 0;
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

async function mount(): Promise<HTMLElement> {
  const mounted = await mountForInteraction(
    createElement(PermissionRequestModal, {
      sessionKey: REQUEST.sessionKey,
      title: "Fix the API",
      onClose: () => closed++,
      onGoToSession: () => wentToSession++,
    }),
  );
  unmount = mounted.unmount;
  return mounted.host;
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

describe("PermissionRequestModal", () => {
  it("shows the command and what Claude said before asking", async () => {
    queue = [REQUEST];
    const host = await mount();
    const text = host.textContent ?? "";
    expect(text).toContain("Fix the API");
    expect(text).toContain("rm -rf build");
    expect(text).toContain("Clean the build output");
    expect(text).toContain("The build folder is stale");
    expect(text).toContain("/Users/me/ws/fix-the-api");
  });

  it("approves the front request and closes once nothing else waits", async () => {
    queue = [REQUEST];
    const host = await mount();
    await armed();
    button(host, "Approve").click();
    await armed();
    expect(decisions).toEqual([["req-1", { behavior: "allow" }]]);
    expect(closed).toBe(1);
  });

  it("hands the prompt to the terminal and opens the session", async () => {
    queue = [REQUEST];
    const host = await mount();
    await armed();
    button(host, "Answer in terminal").click();
    await armed();
    expect(decisions).toEqual([["req-1", { behavior: "terminal" }]]);
    expect(wentToSession).toBe(1);
  });

  it("says so when the session is no longer waiting", async () => {
    queue = [];
    const host = await mount();
    expect(host.textContent).toContain("isn't waiting on Yarvis any more");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Approve")).toBe(
      false,
    );
  });

  it("denies with the note the user typed", async () => {
    queue = [REQUEST];
    const host = await mount();
    await armed();
    const input = host.querySelector("input") as HTMLInputElement;
    // React tracks the value itself, so set it the way a keystroke would.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Use the clean script",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await armed();
    button(host, "Send").click();
    await armed();
    expect(decisions).toEqual([["req-1", { behavior: "deny", message: "Use the clean script" }]]);
  });

  it("stays open and says so when the prompt was already answered elsewhere", async () => {
    queue = [REQUEST];
    delivers = false;
    const host = await mount();
    await armed();
    button(host, "Deny").click();
    await armed();
    expect(decisions).toEqual([["req-1", { behavior: "deny" }]]);
    expect(host.textContent).toContain("already answered or timed out");
    expect(closed).toBe(0);
  });

  it("ignores a second click that would land on the next request in the queue", async () => {
    queue = [REQUEST, { ...REQUEST, id: "req-2", toolInput: { command: "bun test" } }];
    const host = await mount();
    expect(host.textContent).toContain("+1 waiting");
    await armed();
    button(host, "Approve").click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    button(host, "Approve").click();
    await armed();
    expect(decisions).toEqual([["req-1", { behavior: "allow" }]]);
    expect(host.textContent).toContain("bun test");
    expect(closed).toBe(0);
  });

  it("never hides a Bash field beyond the command, and flags an unsandboxed run", async () => {
    queue = [
      {
        ...REQUEST,
        toolInput: { ...REQUEST.toolInput, dangerouslyDisableSandbox: true, timeout: 600000 },
      },
    ];
    const host = await mount();
    const text = host.textContent ?? "";
    expect(text).toContain("Runs outside the sandbox");
    expect(text).toContain('"dangerouslyDisableSandbox": true');
    expect(text).toContain('"timeout": 600000');
  });
});
