import { describe, expect, it } from "bun:test";
import { errorText, formatError } from "./errors";

describe("formatError", () => {
  it("uses an Error's message and keeps its stack as the detail", () => {
    const formatted = formatError(new Error("sessions failed (500)"));
    expect(formatted.message).toBe("sessions failed (500)");
    expect(formatted.detail).toContain("sessions failed");
  });

  it("prefers a server-supplied detail over the stack", () => {
    const err = Object.assign(new Error("chat failed (400)"), { detail: "status=400 body=nope" });
    expect(formatError(err).detail).toBe("status=400 body=nope");
  });

  it("unwraps a thrown object instead of rendering [object Object]", () => {
    const formatted = formatError({ error: { message: "model not found" } });
    expect(formatted.message).toBe("model not found");
    expect(formatted.detail).toContain("model not found");
  });

  it("still says something useful for an object with no message", () => {
    const formatted = formatError({ code: "ECONNREFUSED" });
    expect(formatted.message).toBe("Unknown error");
    expect(formatted.detail).toContain("ECONNREFUSED");
  });

  it("survives a circular object", () => {
    const circular: Record<string, unknown> = { code: 1 };
    circular.self = circular;
    expect(formatError(circular).detail).toContain("[circular]");
  });

  it("handles primitives and null", () => {
    expect(formatError("boom").message).toBe("boom");
    expect(formatError(null).message).toBe("null");
  });
});

describe("errorText", () => {
  it("joins the line and the detail for the clipboard", () => {
    expect(errorText({ message: "a", detail: "b" })).toBe("a\n\nb");
    expect(errorText({ message: "a" })).toBe("a");
  });
});
