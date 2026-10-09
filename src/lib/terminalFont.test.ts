import { beforeEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  getTerminalFontSize,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  onTerminalFontSize,
  resolveFontSizeKey,
  setTerminalFontSize,
  stepTerminalFontSize,
} from "./terminalFont";

const key = (
  overrides: Partial<Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">>,
) => ({
  key: "=",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  ...overrides,
});

describe("resolveFontSizeKey", () => {
  it("maps Cmd+= / Cmd+- / Cmd+0 to a step", () => {
    expect(resolveFontSizeKey(key({ key: "=" }))).toBe("increase");
    expect(resolveFontSizeKey(key({ key: "+" }))).toBe("increase");
    expect(resolveFontSizeKey(key({ key: "-" }))).toBe("decrease");
    expect(resolveFontSizeKey(key({ key: "0" }))).toBe("reset");
  });

  it("leaves Ctrl+- to the shell, where it is Claude Code's undo", () => {
    expect(resolveFontSizeKey(key({ key: "-", metaKey: false, ctrlKey: true }))).toBeNull();
    expect(resolveFontSizeKey(key({ key: "-", ctrlKey: true }))).toBeNull();
  });

  it("ignores the keys without Cmd, and with Alt held", () => {
    expect(resolveFontSizeKey(key({ key: "=", metaKey: false }))).toBeNull();
    expect(resolveFontSizeKey(key({ key: "=", altKey: true }))).toBeNull();
    expect(resolveFontSizeKey(key({ key: "1" }))).toBeNull();
  });
});

describe("terminal font size", () => {
  beforeEach(() => setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE));

  it("steps by one and resets to the default", () => {
    stepTerminalFontSize("increase");
    stepTerminalFontSize("increase");
    expect(getTerminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE + 2);
    stepTerminalFontSize("decrease");
    expect(getTerminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE + 1);
    stepTerminalFontSize("reset");
    expect(getTerminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it("stays within the bounds", () => {
    setTerminalFontSize(1000);
    expect(getTerminalFontSize()).toBe(MAX_TERMINAL_FONT_SIZE);
    setTerminalFontSize(1);
    expect(getTerminalFontSize()).toBe(MIN_TERMINAL_FONT_SIZE);
  });

  it("persists the size and tells every subscriber", () => {
    const seen: number[] = [];
    const off = onTerminalFontSize((size) => seen.push(size));
    setTerminalFontSize(20);
    off();
    setTerminalFontSize(21);
    expect(seen).toEqual([20]);
    expect(localStorage.getItem("yarvis.terminalFontSize")).toBe("21");
  });

  it("does not notify when the size is unchanged", () => {
    const seen: number[] = [];
    const off = onTerminalFontSize((size) => seen.push(size));
    setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE);
    off();
    expect(seen).toEqual([]);
  });
});
