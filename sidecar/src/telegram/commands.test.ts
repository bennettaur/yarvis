import { describe, expect, it } from "bun:test";
import { parseCommand } from "./commands.ts";

describe("parseCommand", () => {
  it("returns null for non-commands", () => {
    expect(parseCommand("hello there")).toBeNull();
    expect(parseCommand("  no slash here")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });

  it("parses a bare command", () => {
    expect(parseCommand("/help")).toEqual({ name: "help", args: "" });
  });

  it("lowercases the command name", () => {
    expect(parseCommand("/HELP")).toEqual({ name: "help", args: "" });
  });

  it("captures arguments after the command", () => {
    expect(parseCommand("/switch 3")).toEqual({ name: "switch", args: "3" });
    expect(parseCommand("/switch   3  ")).toEqual({ name: "switch", args: "3" });
  });

  it("strips the @botname suffix used in groups", () => {
    expect(parseCommand("/help@yarvis_bot")).toEqual({ name: "help", args: "" });
    expect(parseCommand("/switch@yarvis_bot 2")).toEqual({ name: "switch", args: "2" });
  });

  it("returns null for a lone slash", () => {
    expect(parseCommand("/")).toBeNull();
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseCommand("  /new_chat  ")).toEqual({ name: "new_chat", args: "" });
  });
});
