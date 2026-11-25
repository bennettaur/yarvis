import { describe, expect, it } from "bun:test";
import { fullRunTrigger, SUITES } from "./affected-tests.ts";

describe("fullRunTrigger", () => {
  it("leaves an ordinary source change to bun's import tracing", () => {
    expect(fullRunTrigger(SUITES.sidecar, ["sidecar/src/chat/agent.ts", "docs/x.md"])).toBeNull();
  });

  it("runs everything when the lockfile changes", () => {
    expect(fullRunTrigger(SUITES.frontend, ["src/App.tsx", "bun.lock"])).toBe("bun.lock");
  });

  it("matches a folder entry against anything inside it", () => {
    expect(fullRunTrigger(SUITES.sidecar, ["sidecar/drizzle/0063_x.sql"])).toBe(
      "sidecar/drizzle/0063_x.sql",
    );
  });

  it("matches a file entry exactly, not as a prefix", () => {
    expect(fullRunTrigger(SUITES.frontend, ["tsconfig.json.bak"])).toBeNull();
  });

  it("runs the frontend suite in full for the sidecar preload it also loads", () => {
    expect(fullRunTrigger(SUITES.frontend, ["sidecar/src/test/setup.ts"])).not.toBeNull();
  });

  it("keeps the sidecar's migrations from forcing a full frontend run", () => {
    expect(fullRunTrigger(SUITES.frontend, ["sidecar/drizzle/0063_x.sql"])).toBeNull();
  });
});
