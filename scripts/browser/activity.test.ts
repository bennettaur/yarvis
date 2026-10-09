import { describe, expect, it } from "bun:test";
import {
  type ActivityRow,
  describeResult,
  MAX_LOG_BYTES,
  MAX_RESULT_CHARS,
  nextIndex,
  storedBytes,
  TOOL_FOR_COMMAND,
} from "../../extension/activity.js";

describe("describeResult", () => {
  it("keeps a whole result as readable JSON", () => {
    expect(describeResult({ ok: true, data: { url: "https://a" } })).toEqual({
      result: '{\n  "url": "https://a"\n}',
      resultTruncated: false,
    });
  });

  it("shows the error for a failed command", () => {
    expect(describeResult({ ok: false, error: "That link leaves this site." }).result).toBe(
      "That link leaves this site.",
    );
  });

  it("cuts a result too large for session storage and says so", () => {
    const out = describeResult({ ok: true, data: "x".repeat(MAX_RESULT_CHARS * 2) });
    expect(out.result).toHaveLength(MAX_RESULT_CHARS);
    expect(out.resultTruncated).toBe(true);
  });
});

describe("TOOL_FOR_COMMAND", () => {
  it("names the tool behind every command the extension answers", () => {
    expect(Object.keys(TOOL_FOR_COMMAND).sort()).toEqual(
      ["click", "inspect", "list_elements", "list_tabs", "navigate", "read_page", "scroll"].sort(),
    );
  });
});

function row(id: string, bytes: number): ActivityRow {
  return { id, at: 0, durationMs: 0, instance: "", tool: "t", ok: true, bytes };
}

describe("nextIndex", () => {
  it("puts the newest entry first", () => {
    const { index, dropped } = nextIndex([row("a", 10)], row("b", 10));
    expect(index.map((r) => r.id)).toEqual(["b", "a"]);
    expect(dropped).toEqual([]);
  });

  it("drops the oldest entries past fifty", () => {
    const existing = Array.from({ length: 50 }, (_, i) => row(`old-${i}`, 1));
    const { index, dropped } = nextIndex(existing, row("new", 1));
    expect(index).toHaveLength(50);
    expect(dropped).toEqual(["old-49"]);
  });

  it("drops the oldest entries once the log would outgrow its byte budget", () => {
    const half = Math.floor(MAX_LOG_BYTES / 2);
    const { index, dropped } = nextIndex(
      [row("newer", half), row("older", half)],
      row("new", half),
    );
    expect(index.map((r) => r.id)).toEqual(["new", "newer"]);
    expect(dropped).toEqual(["older"]);
  });
});

describe("storedBytes", () => {
  it("counts escapes and multi-byte characters the way storage does", () => {
    expect(storedBytes("a\nb")).toBe(6);
    expect(storedBytes("é")).toBe(4);
  });
});
