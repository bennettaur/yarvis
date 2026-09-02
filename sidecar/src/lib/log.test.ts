import { beforeEach, describe, expect, it } from "bun:test";
import { clearLogs, knownScopes, recentLogs, record } from "./log.ts";

beforeEach(() => {
  clearLogs();
});

describe("record", () => {
  it("splits the [scope] prefix every sidecar log line already carries", () => {
    record("error", ["[chat] model error: nope"]);
    const [entry] = recentLogs();
    expect(entry?.scope).toBe("chat");
    expect(entry?.message).toBe("model error: nope");
  });

  it("keeps an unprefixed line whole", () => {
    record("info", ["listening on 127.0.0.1:1234"]);
    expect(recentLogs()[0]).toMatchObject({ scope: null, message: "listening on 127.0.0.1:1234" });
  });

  it("renders an Error and a plain object rather than [object Object]", () => {
    record("error", ["[mcp] failed:", Object.assign(new Error("boom"), { statusCode: 502 })]);
    record("error", ["[mcp] payload:", { code: "ECONNREFUSED" }]);
    const messages = recentLogs().map((e) => e.message);
    expect(messages[0]).toContain("boom status=502");
    expect(messages[1]).toContain("ECONNREFUSED");
    expect(messages.join()).not.toContain("[object Object]");
  });

  it("redacts credentials before they are held in memory", () => {
    record("error", ["[llm] Wrong API key provided: sk-ant-abcdef0123456789abcdef."]);
    expect(recentLogs()[0]?.message).toContain("[redacted-token]");
  });
});

describe("recentLogs", () => {
  it("filters by level, scope, text and cursor", () => {
    record("debug", ["[chat] noisy"]);
    record("warn", ["[chat] careful"]);
    record("error", ["[mcp] broken"]);

    expect(recentLogs({ minLevel: "warn" }).map((e) => e.message)).toEqual(["careful", "broken"]);
    expect(recentLogs({ scope: "mcp" }).map((e) => e.message)).toEqual(["broken"]);
    expect(recentLogs({ contains: "CARE" }).map((e) => e.message)).toEqual(["careful"]);

    const after = recentLogs()[0]!.seq;
    expect(recentLogs({ after }).map((e) => e.message)).toEqual(["careful", "broken"]);
  });

  it("returns the newest entries when the limit bites", () => {
    for (let i = 0; i < 5; i++) record("info", [`line ${i}`]);
    expect(recentLogs({ limit: 2 }).map((e) => e.message)).toEqual(["line 3", "line 4"]);
  });
});

describe("knownScopes", () => {
  it("lists each scope once, sorted", () => {
    record("info", ["[mcp] a"]);
    record("info", ["[chat] b"]);
    record("info", ["[mcp] c"]);
    record("info", ["unscoped"]);
    expect(knownScopes()).toEqual(["chat", "mcp"]);
  });
});

describe("capacity and truncation", () => {
  it("keeps only the newest lines once the buffer is full", () => {
    for (let i = 0; i < 2100; i++) record("info", [`line ${i}`]);
    const kept = recentLogs({ limit: 2000 });
    expect(kept).toHaveLength(2000);
    expect(kept[0]?.message).toBe("line 100");
  });

  it("redacts before truncating, so a token straddling the cut can't survive", () => {
    const token = "sk-ant-abcdef0123456789abcdef";
    record("error", [`${"x".repeat(7985)} ${token}`]);
    const [entry] = recentLogs();
    expect(entry?.message).not.toContain("sk-ant-");
  });
});
