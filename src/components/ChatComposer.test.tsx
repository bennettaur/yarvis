import { afterEach, describe, expect, it } from "bun:test";
import type { ComponentProps } from "react";
import { mountForInteraction } from "../test/render";
import ChatComposer from "./ChatComposer";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function mount(props: Partial<ComponentProps<typeof ChatComposer>>) {
  const mounted = await mountForInteraction(
    <ChatComposer
      value="hi"
      onChange={() => {}}
      onSubmit={() => {}}
      submitLabel="Send"
      {...props}
    />,
  );
  cleanup = mounted.unmount;
  return mounted.host;
}

function buttons(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll("button"));
}

describe("ChatComposer", () => {
  it("sends when idle", async () => {
    let sent = 0;
    const host = await mount({ onSubmit: () => sent++, onStop: () => {} });
    expect(buttons(host).map((b) => b.textContent)).toEqual(["Send"]);
    buttons(host)[0]?.click();
    expect(sent).toBe(1);
  });

  it("offers Stop instead of Send while a turn is running", async () => {
    let stopped = 0;
    const host = await mount({ busy: true, onStop: () => stopped++ });
    expect(buttons(host).map((b) => b.textContent)).toEqual(["Stop"]);
    buttons(host)[0]?.click();
    expect(stopped).toBe(1);
  });

  it("disables sending while busy on a surface that can't stop", async () => {
    const host = await mount({ busy: true, submitLabel: "Build" });
    const [submit] = buttons(host);
    expect(submit?.textContent).toBe("Build");
    expect(submit?.disabled).toBe(true);
    expect(host.querySelector("textarea")?.disabled).toBe(true);
  });

  it("sends on Enter but not on Shift+Enter", async () => {
    let sent = 0;
    const host = await mount({ onSubmit: () => sent++ });
    const box = host.querySelector("textarea");
    box?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );
    expect(sent).toBe(0);
    box?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sent).toBe(1);
  });

  it("puts the caller's controls in the toolbar", async () => {
    const host = await mount({ tools: <select title="Model" /> });
    expect(host.querySelector('select[title="Model"]')).not.toBeNull();
  });
});
