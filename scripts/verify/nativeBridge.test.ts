import { describe, expect, it } from "bun:test";
import {
  bridgeViolations,
  ORDINARY_COMMANDS,
  PRIVILEGED_COMMANDS,
  readFrontendSources,
  registeredCommands,
} from "./nativeBridge.ts";
import { PRIVILEGED_FRONTEND_FILES, PRIVILEGED_FRONTEND_IMPORTERS } from "./tier.ts";

const CORE = 'import { invoke } from "@tauri-apps/api/core";';
const file = (text: string, path = "src/lib/other.ts") => [{ path, text }];

describe("the frontend's native bridge", () => {
  it("holds for everything in src/", () => {
    expect(bridgeViolations(readFrontendSources())).toEqual([]);
  });

  it("classifies every command the Rust core registers", () => {
    // A new command must be put on one list or the other on purpose.
    const classified = [...Object.keys(PRIVILEGED_COMMANDS), ...ORDINARY_COMMANDS];
    // Guards the parse itself: finding no commands would pass the check below.
    expect(registeredCommands()).toContain("set_secret");
    expect(registeredCommands().filter((command) => !classified.includes(command))).toEqual([]);
    expect(ORDINARY_COMMANDS.filter((command) => PRIVILEGED_COMMANDS[command])).toEqual([]);
  });

  it("lists exactly the files that import privilegedCommands, with none left over", () => {
    const importers = readFrontendSources()
      .filter(({ text }) => /from\s+["'](?:\.\.?\/)+(?:lib\/)?privilegedCommands["']/.test(text))
      .map(({ path }) => path)
      .sort();
    expect([...PRIVILEGED_FRONTEND_IMPORTERS].sort()).toEqual(importers);
  });

  it("marks every file allowed a privileged command as high risk", () => {
    const owners = [...new Set(Object.values(PRIVILEGED_COMMANDS))].sort();
    expect([...PRIVILEGED_FRONTEND_FILES].sort()).toEqual(owners);
  });
});

describe("bridgeViolations", () => {
  it("allows ordinary literal calls from any file", () => {
    expect(
      bridgeViolations(
        file(`${CORE}\nexport const x = () => invoke<Record<string, boolean>>("list_alarms");`),
      ),
    ).toEqual([]);
  });

  it("allows a privileged call from its own file", () => {
    expect(
      bridgeViolations(file(`${CORE}\ninvoke("set_secret", {});`, "src/lib/privilegedCommands.ts")),
    ).toEqual([]);
  });

  it("flags a privileged call from any other file", () => {
    expect(bridgeViolations(file(`${CORE}\ninvoke("set_secret", {});`))).toEqual([
      "src/lib/other.ts calls set_secret, which belongs in src/lib/privilegedCommands.ts",
    ]);
  });

  it("flags a command name that isn't a plain literal", () => {
    for (const call of ["invoke(name)", 'invoke("set_" + "secret")', "const run = invoke;"]) {
      expect(bridgeViolations(file(`${CORE}\n${call}`))).toEqual([
        "src/lib/other.ts uses invoke other than with a literal command name",
      ]);
    }
  });

  it("flags other routes to Tauri", () => {
    for (const text of [
      'import { invoke as call } from "@tauri-apps/api/core";',
      'import { core } from "@tauri-apps/api";',
      'const core = await import("@tauri-apps/api/core");',
      "window.__TAURI_INTERNALS__.invoke('set_secret');",
    ]) {
      expect(bridgeViolations(file(text))).toContain(
        "src/lib/other.ts reaches Tauri other than through the plain invoke import",
      );
    }
  });

  it("allows listening for events from any file", () => {
    expect(bridgeViolations(file('import { listen } from "@tauri-apps/api/event";'))).toEqual([]);
  });

  it("flags a privileged sidecar write from any other file, in either call shape", () => {
    expect(
      bridgeViolations(file('sidecarFetch("/api/mcp/servers", { method: "POST", body: "{}" });')),
    ).toEqual([
      "src/lib/other.ts writes POST /api/mcp/servers, which belongs in src/lib/privilegedCommands.ts",
    ]);
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a template
      bridgeViolations(file('jobsRequest(`/api/jobs/agent-jobs/${id}`, "PUT", input);')),
    ).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a template
      "src/lib/other.ts writes PUT /api/jobs/agent-jobs/${id}, which belongs in src/lib/privilegedCommands.ts",
    ]);
  });

  it("allows reads and ordinary writes on the same routes", () => {
    for (const call of [
      'sidecarFetch("/api/mcp/servers");',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a template
      'sidecarFetch(`/api/mcp/servers/${id}`, { method: "DELETE" });',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a template
      'sidecarFetch(`/api/mcp/servers/${id}/refresh`, { method: "POST" });',
      'sidecarFetch("/api/mcp/tools/search", { method: "POST" });',
    ]) {
      expect(bridgeViolations(file(call))).toEqual([]);
    }
  });

  it("flags an importer of privilegedCommands that isn't on the high-risk list", () => {
    expect(
      bridgeViolations(
        file('import { setAgent } from "../lib/privilegedCommands";', "src/components/New.tsx"),
      ),
    ).toEqual([
      "src/components/New.tsx imports privilegedCommands but isn't in PRIVILEGED_FRONTEND_IMPORTERS",
    ]);
  });

  it("flags reading the sidecar token outside api.ts", () => {
    expect(bridgeViolations(file('import { sidecarInfo } from "./api";'))).toEqual([
      "src/lib/other.ts reads the sidecar token, which only src/lib/api.ts may",
    ]);
  });

  it("flags a plugin imported outside the file that wraps it", () => {
    expect(bridgeViolations(file('import { openUrl } from "@tauri-apps/plugin-opener";'))).toEqual([
      "src/lib/other.ts imports @tauri-apps/plugin-opener, which only src/lib/url.ts may",
    ]);
  });
});
