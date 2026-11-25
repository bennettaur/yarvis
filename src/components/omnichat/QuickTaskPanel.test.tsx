import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { registerContext } from "../../lib/omniChatContext";
import { mountForInteraction, waitFor } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";
import QuickTaskPanel from "./QuickTaskPanel";

const calls: { path: string; body: Record<string, unknown> }[] = [];
const proposal = {
  title: "Merge billing PR",
  kind: "ship",
  focus: "When CI is green.",
  priority: "high",
  links: [{ ref: { kind: "workspace", workspaceId: "w1" }, title: "billing" }],
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** What the next propose call answers; reset to the plain proposal after each test. */
let proposeReply: () => Response = () => json(proposal);

stubSidecarApi({
  sidecarFetch: async (path: string, init?: RequestInit) => {
    calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
    return path.endsWith("/propose") ? proposeReply() : json({ ...proposal, id: "s1" });
  },
});
afterEach(() => {
  calls.length = 0;
  proposeReply = () => json(proposal);
});
afterAll(resetSidecarApi);

const buttonIn = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label) as
    | HTMLButtonElement
    | undefined;

/** Mounts the panel, types a message and presses Parse. */
async function parse(message: string) {
  const view = await mountForInteraction(
    createElement(QuickTaskPanel, { open: true, provider: "p", model: "m" }),
  );
  const box = view.host.querySelector("textarea") as HTMLTextAreaElement;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  set?.call(box, message);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(() => buttonIn(view.host, "Parse")?.disabled === false, "Parse to be enabled");
  buttonIn(view.host, "Parse")?.click();
  return view;
}

describe("QuickTaskPanel", () => {
  it("shows the parsed task and creates nothing until confirmed", async () => {
    const unregister = registerContext("workspaces", () => ({
      source: "workspaces",
      summary: "Viewing workspace",
      details: { workspaceId: "w1" },
    }));
    const view = await mountForInteraction(
      createElement(QuickTaskPanel, { open: true, provider: "p", model: "m" }),
    );
    const button = (label: string) =>
      [...view.host.querySelectorAll("button")].find((b) => b.textContent === label) as
        | HTMLButtonElement
        | undefined;
    const box = view.host.querySelector("textarea") as HTMLTextAreaElement;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    set?.call(box, "get this merged");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => button("Parse")?.disabled === false, "Parse to be enabled");
    button("Parse")?.click();
    await waitFor(() => button("Add to heads down") !== undefined);

    expect(calls.map((c) => c.path)).toEqual(["/api/work-streams/quick-task/propose"]);
    expect(calls[0]?.body.workspaceId).toBe("w1");

    const title = view.host.querySelector("input") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(title, "Edited title");
    title.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(
      () => (view.host.querySelector("input") as HTMLInputElement).value === "Edited title",
    );
    (view.host.querySelector('[aria-label^="Remove"]') as HTMLButtonElement).click();
    await waitFor(() => view.host.querySelector('[aria-label^="Remove"]') === null);
    button("Add to heads down")?.click();
    await waitFor(() => calls.length === 2);
    expect(calls[1]?.path).toBe("/api/work-streams/quick-task");
    expect(calls[1]?.body.title).toBe("Edited title");
    expect(calls[1]?.body.links).toEqual([]);
    await waitFor(() => (view.host.textContent ?? "").includes("Added"));
    unregister();
    view.unmount();
  });

  it("labels each proposed link by what it is", async () => {
    proposeReply = () =>
      json({
        ...proposal,
        links: [
          { ref: { kind: "workspace", workspaceId: "w1" }, title: "billing" },
          {
            ref: { kind: "pr", provider: "github", url: "https://github.com/o/r/pull/9" },
            title: "r #9",
          },
          { ref: { kind: "pr", provider: "github", url: "https://github.com/o/r/pull/10" } },
          { ref: { kind: "ticket", provider: "jira", key: "ABC-12" }, title: "ABC-12" },
        ],
      });
    const view = await parse("ship it");
    await waitFor(() => buttonIn(view.host, "Add to heads down") !== undefined, "the proposal");

    const labels = [...view.host.querySelectorAll('[aria-label^="Remove "]')].map((b) =>
      b.getAttribute("aria-label")?.slice("Remove ".length),
    );
    expect(labels).toEqual([
      "workspace: billing",
      "pr: r #9",
      "pr: https://github.com/o/r/pull/10",
      "ticket: ABC-12",
    ]);
    view.unmount();
  });

  it("shows a failed proposal with its detail", async () => {
    proposeReply = () =>
      new Response(JSON.stringify({ error: "could not propose a task", detail: "model down" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    const view = await parse("ship it");
    await waitFor(() => view.host.querySelector('[role="alert"]') !== null, "the error");

    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain(
      "could not propose a task",
    );
    buttonIn(view.host, "Show details")?.click();
    await waitFor(() => (view.host.textContent ?? "").includes("model down"), "the detail");
    expect(buttonIn(view.host, "Add to heads down")).toBeUndefined();
    view.unmount();
  });
});
