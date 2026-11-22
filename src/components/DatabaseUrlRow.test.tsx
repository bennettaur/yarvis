import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { resetCore, stubCore } from "../test/coreApi";
import { mountForInteraction, waitFor } from "../test/render";
import DatabaseUrlRow from "./DatabaseUrlRow";

let answer: () => Promise<unknown> = async () => null;
stubCore({
  core: (async (command: string) => {
    if (command !== "get_database_info") throw new Error(`unexpected ${command}`);
    return answer();
  }) as never,
});
afterAll(() => resetCore());

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

async function mount() {
  const mounted = await mountForInteraction(createElement(DatabaseUrlRow));
  unmount = mounted.unmount;
  return mounted.host;
}

describe("DatabaseUrlRow", () => {
  it("shows the masked URL and where it came from, with no way to edit it", async () => {
    answer = async () => ({ url: "postgres://me:****@db.example/yarvis", source: "configFile" });
    const host = await mount();
    await waitFor(() => host.querySelector("code") !== null, "the URL");
    expect(host.querySelector("code")?.textContent).toBe("postgres://me:****@db.example/yarvis");
    expect(host.textContent).toContain("[database] url in server.toml");
    expect(host.querySelector("input")).toBeNull();
  });

  it("names the default when nothing set a URL", async () => {
    answer = async () => ({ url: "postgres://localhost:5432/yarvis", source: "default" });
    const host = await mount();
    await waitFor(() => host.textContent?.includes("by default") === true, "the source");
  });

  it("shows why it couldn't ask", async () => {
    answer = async () => {
      throw new Error("get_database_info failed (403): forbidden");
    };
    const host = await mount();
    await waitFor(() => host.textContent?.includes("403") === true, "the error");
  });
});
