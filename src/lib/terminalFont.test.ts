import { beforeEach, describe, expect, it, mock } from "bun:test";
import { nativeInvoke } from "../test/nativeInvoke";

const saved: unknown[] = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: { value?: unknown }) => {
    if (command === "set_terminal_font_size") {
      saved.push(args.value);
      return;
    }
    return nativeInvoke(command);
  },
}));

const {
  DEFAULT_TERMINAL_FONT_SIZE,
  getTerminalFontSize,
  loadTerminalFontSize,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  onTerminalFontSize,
  resolveFontSizeKey,
  setTerminalFontSize,
  stepTerminalFontSize,
} = await import("./terminalFont");

/** Lets the chained saves run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  beforeEach(async () => {
    setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE);
    await settle();
    saved.length = 0;
  });

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

  it("saves each size in order and tells every subscriber", async () => {
    const seen: number[] = [];
    const off = onTerminalFontSize((size) => seen.push(size));
    setTerminalFontSize(20);
    off();
    setTerminalFontSize(21);
    stepTerminalFontSize("reset");
    await settle();
    expect(seen).toEqual([20]);
    expect(saved).toEqual([20, 21, null]);
  });

  it("clamps a stored size and ignores one that isn't a size", () => {
    loadTerminalFontSize(18);
    expect(getTerminalFontSize()).toBe(18);
    loadTerminalFontSize(500);
    expect(getTerminalFontSize()).toBe(MAX_TERMINAL_FONT_SIZE);
    loadTerminalFontSize("big");
    expect(getTerminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    loadTerminalFontSize(null);
    expect(getTerminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it("does not notify when the size is unchanged", () => {
    const seen: number[] = [];
    const off = onTerminalFontSize((size) => seen.push(size));
    setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE);
    off();
    expect(seen).toEqual([]);
  });
});
