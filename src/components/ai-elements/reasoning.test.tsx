import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "./reasoning";

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** The live state the way `TurnActivity` passes it: both props follow the stream. */
function render(live: boolean) {
  act(() =>
    root?.render(
      <Reasoning isStreaming={live} defaultOpen={live}>
        <ReasoningTrigger />
        <ReasoningContent>weighing it up</ReasoningContent>
      </Reasoning>,
    ),
  );
}

describe("Reasoning", () => {
  it("folds itself a second after streaming stops, even when defaultOpen follows the stream", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    render(true);
    expect(host.textContent).toContain("weighing it up");

    render(false);
    expect(host.textContent).toContain("weighing it up");
    await act(() => new Promise((resolve) => setTimeout(resolve, 1100)));
    expect(host.textContent).not.toContain("weighing it up");
    expect(host.textContent).toContain("Thought for");
  });
});
