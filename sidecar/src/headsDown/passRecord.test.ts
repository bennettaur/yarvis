import { describe, expect, it } from "bun:test";
import { CUT_SHORT_RESULT, type ToolActivity } from "../db/schema.ts";
import { describeActivity } from "./passRecord.ts";

const call = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: "c",
  name: "list_work_streams",
  status: "ok",
  ...overrides,
});

describe("describeActivity", () => {
  it("says how each call ended, with its server and arguments", () => {
    const text = describeActivity([
      call({ args: { awakeOnly: true } }),
      call({ name: "post_message", server: "Slack", status: "error", result: "channel_not_found" }),
      call({ name: "archive_workspace", status: "denied", result: "Not run: needs approval" }),
    ]);
    expect(text).toBe(
      [
        '- done: list_work_streams({"awakeOnly":true})',
        "- failed: Slack/post_message() → channel_not_found",
        "- not run: archive_workspace() → Not run: needs approval",
      ].join("\n"),
    );
  });

  it("marks a call with no result as unknown, not failed, so it isn't repeated blindly", () => {
    const text = describeActivity([
      call({ name: "send_workspace_instruction", status: "pending" }),
      call({ name: "start_work_on_issue", status: "error", result: CUT_SHORT_RESULT }),
    ]);
    expect(text).not.toContain("failed");
    expect(text).toContain(
      "- unknown (no result came back; check before repeating): send_workspace_instruction()",
    );
    expect(text).toContain(
      "- unknown (no result came back; check before repeating): start_work_on_issue()",
    );
  });

  it("clips long arguments and results to one short line", () => {
    const text = describeActivity([
      call({ status: "error", args: "a\n".repeat(300), result: "b ".repeat(300) }),
    ]);
    expect(text).not.toContain("\na");
    expect(text.split("…")).toHaveLength(3);
    expect(text.length).toBeLessThan(500);
  });

  it("lists at most 60 calls and counts the rest", () => {
    const text = describeActivity(Array.from({ length: 65 }, (_, i) => call({ id: `c${i}` })));
    const lines = text.split("\n");
    expect(lines).toHaveLength(61);
    expect(lines.at(-1)).toBe("- and 5 more calls");
  });
});
