import { afterAll, describe, expect, it } from "bun:test";
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

stubSidecarApi({
  sidecarFetch: async (path: string, init?: RequestInit) => {
    calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
    return path.endsWith("/propose") ? json(proposal) : json({ ...proposal, id: "s1" });
  },
});
afterAll(resetSidecarApi);

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
});
