import { describe, expect, it } from "bun:test";
import { clientError, describeError } from "./errors.ts";

describe("describeError", () => {
  it("returns String() for non-Error input", () => {
    expect(describeError("boom")).toBe("boom");
    expect(describeError(42)).toBe("42");
  });

  it("returns just the message for a plain Error", () => {
    expect(describeError(new Error("nope"))).toBe("nope");
  });

  it("appends status, url, and truncated body for an API-style error", () => {
    const err = Object.assign(new Error("bad request"), {
      statusCode: 400,
      url: "https://api.example.com/v1/messages",
      responseBody: "x".repeat(600),
    });
    const out = describeError(err);
    expect(out).toContain("bad request");
    expect(out).toContain("status=400");
    expect(out).toContain("url=https://api.example.com/v1/messages");
    // Body is truncated to 500 chars.
    expect(out).toContain(`body=${"x".repeat(500)}`);
    expect(out).not.toContain("x".repeat(501));
  });

  it("omits an empty response body", () => {
    const err = Object.assign(new Error("e"), { responseBody: "" });
    expect(describeError(err)).toBe("e");
  });

  it("ignores fields of the wrong type", () => {
    const err = Object.assign(new Error("e"), { statusCode: "400", url: 123 });
    expect(describeError(err)).toBe("e");
  });

  it("appends a cause message but not when cause is the error itself", () => {
    const withCause = Object.assign(new Error("outer"), {
      cause: new Error("inner"),
    });
    expect(describeError(withCause)).toContain("cause=inner");

    const selfReferential = new Error("loop");
    (selfReferential as { cause?: unknown }).cause = selfReferential;
    expect(describeError(selfReferential)).toBe("loop");
  });
});

describe("clientError", () => {
  it("returns String() for non-Error input", () => {
    expect(clientError("boom")).toBe("boom");
  });

  it("returns the message plus status, never the url or body", () => {
    const err = Object.assign(new Error("model not found"), {
      statusCode: 404,
      url: "https://api.example.com/secret-endpoint",
      responseBody: "sensitive provider detail",
    });
    const out = clientError(err);
    expect(out).toBe("model not found (status 404)");
    expect(out).not.toContain("secret-endpoint");
    expect(out).not.toContain("sensitive provider detail");
  });

  it("returns just the message when there is no numeric status", () => {
    expect(clientError(new Error("plain"))).toBe("plain");
  });
});
