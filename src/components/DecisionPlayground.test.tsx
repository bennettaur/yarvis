import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { mountForInteraction } from "../test/render";

const calls: { url: string; method: string; body?: string }[] = [];

const actualApi = await import("../lib/api");

mock.module("../lib/api", () => ({
  ...actualApi,
  sidecarFetch: async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body as string | undefined });
    if (url === "/api/specialists") {
      return Response.json({
        userDir: "",
        problems: [],
        specialists: [
          { name: "planner", kind: "task", choices: [], description: "Plans." },
          {
            name: "complexity-router",
            kind: "decision",
            choices: ["low", "medium", "max"],
            description: "Picks a tier.",
          },
        ],
      });
    }
    return Response.json({
      choice: "max",
      reason: "it is long",
      model: { provider: "custom:ollama", model: "jev" },
      elapsedMs: 42,
    });
  },
}));

const { default: DecisionPlayground, parseOptions } = await import("./DecisionPlayground");

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  calls.length = 0;
});

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function type(field: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    field instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
  field.dispatchEvent(
    new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

describe("parseOptions", () => {
  it("reads one option per line, with an optional description", () => {
    expect(parseOptions("calm\n\n urgent: someone is waiting \n")).toEqual([
      { value: "calm" },
      { value: "urgent", description: "someone is waiting" },
    ]);
  });
});

describe("DecisionPlayground", () => {
  it("offers only decision specialists", async () => {
    const mounted = await mountForInteraction(createElement(DecisionPlayground));
    unmount = mounted.unmount;
    await settle();
    const names = [...mounted.host.querySelectorAll("option")].map((o) => o.value);
    expect(names).toEqual(["", "complexity-router"]);
  });

  it("asks a specialist with its own choices and shows the answer", async () => {
    const mounted = await mountForInteraction(createElement(DecisionPlayground));
    unmount = mounted.unmount;
    await settle();

    type(mounted.host.querySelector("select") as HTMLSelectElement, "complexity-router");
    await settle();
    type(
      mounted.host.querySelector("textarea[aria-label=Input]") as HTMLTextAreaElement,
      "Plan the quarter",
    );
    await settle();
    (mounted.host.querySelector("button") as HTMLButtonElement).click();
    await settle();

    const asked = calls.find((c) => c.url === "/api/decision-playground");
    expect(JSON.parse(asked?.body ?? "{}")).toEqual({
      specialist: "complexity-router",
      input: "Plan the quarter",
    });
    expect(mounted.host.textContent).toContain("it is long");
  });

  it("asks with instructions and options written here", async () => {
    const mounted = await mountForInteraction(createElement(DecisionPlayground));
    unmount = mounted.unmount;
    await settle();

    const field = (label: string) =>
      mounted.host.querySelector(`textarea[aria-label=${label}]`) as HTMLTextAreaElement;
    const ask = mounted.host.querySelector("button") as HTMLButtonElement;
    type(field("Instructions"), "Judge the tone.");
    type(field("Input"), "Where is it?");
    type(field("Options"), "calm");
    await settle();
    // One option is not a choice.
    expect(ask.disabled).toBe(true);

    type(field("Options"), "calm\nurgent: someone is waiting");
    await settle();
    ask.click();
    await settle();

    const asked = calls.find((c) => c.url === "/api/decision-playground");
    expect(JSON.parse(asked?.body ?? "{}")).toEqual({
      instructions: "Judge the tone.",
      input: "Where is it?",
      options: [{ value: "calm" }, { value: "urgent", description: "someone is waiting" }],
    });
  });
});
