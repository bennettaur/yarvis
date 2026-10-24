import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { mountForInteraction } from "../test/render";
import ToolManagerSection from "./ToolManagerSection";

function tool(id: string, source: "builtin" | "mcp", serverId: string | null = null) {
  return {
    id,
    source,
    serverId,
    name: id,
    description: "",
    inputSchema: {},
    policy: "always",
    approval: "ask",
    contentHash: "",
    createdAt: "",
    updatedAt: "",
  };
}

const TOOLS = [tool("remember", "builtin"), tool("recall", "builtin"), tool("search", "mcp", "s1")];
const SERVERS = [{ id: "s1", name: "Docs server" }];

// Real exports spread back in: `mock.module` replaces the module for the whole process.
const actualApi = await import("../lib/api");

mock.module("../lib/api", () => ({
  ...actualApi,
  sidecarFetch: async (url: string) => {
    const body = url.startsWith("/api/mcp/servers") ? SERVERS : TOOLS;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
}));

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("ToolManagerSection", () => {
  it("starts each tool group collapsed, with its tool count in the header", async () => {
    const mounted = await mountForInteraction(createElement(ToolManagerSection));
    unmount = mounted.unmount;

    const groups = [...mounted.host.querySelectorAll("details")];
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.open)).toBe(true);
    const summaries = groups.map((g) => g.querySelector("summary")?.textContent);
    expect(summaries[0]).toContain("Built-in");
    expect(summaries[0]).toContain("2 tools");
    expect(summaries[1]).toContain("Docs server");
    expect(summaries[1]).toContain("1 tool");
  });
});
