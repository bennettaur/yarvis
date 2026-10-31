import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { mountForInteraction, renderToHtml, textOf } from "../test/render";
import { resetSidecarApi, stubSidecarApi } from "../test/sidecarApi";
import MutationTestingSection from "./MutationTestingSection";

const DEFAULTS = {
  planningModel: "sonnet",
  planningBudgetUsd: 1,
  explanationModel: "sonnet",
  explanationBudgetUsd: 0.5,
  maxMutants: 12,
  testTimeoutCapSeconds: 300,
};
let config: Record<string, unknown> = { ...DEFAULTS };
const calls: { method: string; body?: string }[] = [];
let nextPatchStatus: number | null = null;

stubSidecarApi({
  sidecarFetch: async (_url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, body: init.body as string | undefined });
    if (method === "PATCH" && nextPatchStatus !== null) {
      const status = nextPatchStatus;
      nextPatchStatus = null;
      return new Response(JSON.stringify({ error: "boom" }), { status });
    }
    if (method === "PATCH") config = { ...config, ...JSON.parse(init.body as string) };
    return new Response(JSON.stringify(config), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  calls.length = 0;
  nextPatchStatus = null;
  config = { ...DEFAULTS };
});

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("MutationTestingSection", () => {
  it("shows the model, budget and mutant cap", async () => {
    const text = textOf(await renderToHtml(createElement(MutationTestingSection)));
    expect(text).toContain("Mutation testing");
    expect(text).toContain("Planning model");
    expect(text).toContain("Explanation model");
    expect(text).toContain("Longest test run");
    expect(text).toContain("Planning budget");
    expect(text).toContain("Most mutants per run");
  });

  it("saves the model on picking one, and a number on leaving its field", async () => {
    const mounted = await mountForInteraction(createElement(MutationTestingSection));
    unmount = mounted.unmount;

    setValue(mounted.host.querySelector("select") as HTMLSelectElement, "opus");
    await settle();
    const mutants = mounted.host.querySelectorAll("input")[2] as HTMLInputElement;
    setValue(mutants, "6");
    // Nothing is sent while typing.
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    mutants.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await settle();

    expect(calls.filter((c) => c.method === "PATCH").map((c) => JSON.parse(c.body ?? ""))).toEqual([
      { planningModel: "opus" },
      { maxMutants: 6 },
    ]);
  });

  it("refuses an out-of-range value without saving it", async () => {
    const mounted = await mountForInteraction(createElement(MutationTestingSection));
    unmount = mounted.unmount;
    const mutants = mounted.host.querySelectorAll("input")[2] as HTMLInputElement;
    setValue(mutants, "99");
    mutants.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await settle();

    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(mounted.host.textContent).toContain("from 1 to 30");
    expect(mutants.value).toBe("12");
  });

  it("puts the saved value back when a save fails", async () => {
    nextPatchStatus = 503;
    const mounted = await mountForInteraction(createElement(MutationTestingSection));
    unmount = mounted.unmount;
    const select = mounted.host.querySelector("select") as HTMLSelectElement;
    setValue(select, "haiku");
    await settle();
    expect(mounted.host.textContent).toContain("failed");
    expect(select.value).toBe("sonnet");
  });
});

afterAll(resetSidecarApi);
