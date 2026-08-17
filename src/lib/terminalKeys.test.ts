import { describe, expect, it } from "bun:test";
import { AGENT_NEWLINE_SEQUENCE, resolveTerminalKey } from "./terminalKeys";

const key = (
  overrides: Partial<
    Pick<KeyboardEvent, "key" | "type" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">
  >,
) => ({
  key: "Enter",
  type: "keydown",
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...overrides,
});

describe("resolveTerminalKey", () => {
  it("writes the newline sequence for Shift+Enter and keeps it away from xterm", () => {
    expect(resolveTerminalKey(key({ shiftKey: true }))).toEqual({
      write: AGENT_NEWLINE_SEQUENCE,
      passToXterm: false,
    });
  });

  it("swallows the keypress that follows Shift+Enter so no bare CR submits the prompt", () => {
    expect(resolveTerminalKey(key({ shiftKey: true, type: "keypress" }))).toEqual({
      passToXterm: false,
    });
  });

  it("leaves the Shift+Enter keyup to xterm, which refreshes focus and cursor style", () => {
    expect(resolveTerminalKey(key({ shiftKey: true, type: "keyup" }))).toEqual({
      passToXterm: true,
    });
  });

  it("leaves plain Enter alone so it still submits", () => {
    for (const type of ["keydown", "keypress", "keyup"]) {
      expect(resolveTerminalKey(key({ type }))).toEqual({ passToXterm: true });
    }
  });

  it("leaves Enter with another modifier alone", () => {
    for (const modifier of ["ctrlKey", "altKey", "metaKey"] as const) {
      expect(resolveTerminalKey(key({ shiftKey: true, [modifier]: true }))).toEqual({
        passToXterm: true,
      });
    }
  });

  it("leaves other keys alone", () => {
    expect(resolveTerminalKey(key({ key: "a", shiftKey: true }))).toEqual({ passToXterm: true });
  });
});
