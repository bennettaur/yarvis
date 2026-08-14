import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcpConfig, writeMcpConfig } from "./mcpConfig.ts";

describe("workspace .mcp.json", () => {
  it("points at the sidecar through the session's environment, never a literal token", () => {
    const servers = buildMcpConfig().mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.yarvis).toEqual({
      type: "http",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands these, not JS.
      url: "http://127.0.0.1:${YARVIS_SIDECAR_PORT}/mcp",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands these, not JS.
      headers: { Authorization: "Bearer ${YARVIS_MCP_TOKEN}" },
    });
  });

  it("keeps the user's own servers and unrelated keys", () => {
    const merged = buildMcpConfig({
      mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
      somethingElse: true,
    });
    const servers = merged.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers).sort()).toEqual(["linear", "yarvis"]);
    expect(merged.somethingElse).toBe(true);
  });

  it("refreshes a prior entry rather than stacking a second one", () => {
    const stale = buildMcpConfig({
      mcpServers: { yarvis: { type: "http", url: "http://127.0.0.1:1234/mcp" } },
    });
    const servers = stale.mcpServers as Record<string, Record<string, unknown>>;
    expect(Object.keys(servers)).toEqual(["yarvis"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands these, not JS.
    expect(servers.yarvis?.url).toBe("http://127.0.0.1:${YARVIS_SIDECAR_PORT}/mcp");
  });

  it("keeps a user's own server when rewriting an existing file", () => {
    const root = mkdtempSync(join(tmpdir(), "yarvis-mcp-config-"));
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
      }),
    );

    writeMcpConfig(root);

    const written = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { url?: string }>;
    };
    expect(Object.keys(written.mcpServers).sort()).toEqual(["linear", "yarvis"]);
    expect(written.mcpServers.linear?.url).toBe("https://mcp.linear.app/mcp");
  });

  it("writes the file at the workspace root, overwriting a corrupt one", () => {
    const root = mkdtempSync(join(tmpdir(), "yarvis-mcp-config-"));
    writeFileSync(join(root, ".mcp.json"), "{ not json");

    writeMcpConfig(root);

    const written = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(written.mcpServers)).toEqual(["yarvis"]);
  });
});
