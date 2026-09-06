import { describe, expect, it } from "bun:test";
import { clientError, describeError, errorDetail, errorMessage, redactSecrets } from "./errors.ts";

describe("redactSecrets", () => {
  it("redacts api-key tokens echoed back in a provider error body", () => {
    // Cerebras keys are `csk-`-prefixed, which a bare `\bsk-` pattern misses.
    for (const token of ["csk-abcdef0123456789abcdef", "sk-ant-abcdef0123456789abcdef"]) {
      const out = redactSecrets(`Wrong API key provided: ${token}.`);
      expect(out).toBe("Wrong API key provided: [redacted-token].");
    }
  });
});

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

describe("errors thrown as plain objects", () => {
  // The shape an OpenAI-compatible gateway (e.g. litellm) rejects with, and the
  // reason a failed chat used to read as "[object Object]".
  const gatewayError = {
    error: { message: "model not found", type: "invalid_request" },
    status: 404,
  };

  it("unwraps a nested message instead of stringifying the object", () => {
    expect(errorMessage(gatewayError)).toBe("model not found");
    expect(clientError(gatewayError)).toBe("model not found (status 404)");
    expect(describeError(gatewayError)).toContain("model not found");
  });

  it("never returns [object Object] for an object with no message", () => {
    expect(errorMessage({ code: "ECONNREFUSED" })).toBe('{"code":"ECONNREFUSED"}');
    expect(clientError({})).toBe("<Object with no readable fields>");
  });

  it("survives a circular object", () => {
    const circular: Record<string, unknown> = { code: 1 };
    circular.self = circular;
    expect(errorMessage(circular)).toContain("[circular]");
  });
});

describe("errorDetail", () => {
  it("carries the status, endpoint and provider body the inline line omits", () => {
    const err = Object.assign(new Error("bad request"), {
      statusCode: 400,
      url: "https://litellm.internal/v1/responses",
      responseBody: '{"error":"unsupported endpoint"}',
    });
    const out = errorDetail(err);
    expect(out).toContain("status=400");
    expect(out).toContain("url=https://litellm.internal/v1/responses");
    expect(out).toContain("unsupported endpoint");
  });

  it("redacts credentials a provider echoed back", () => {
    const err = Object.assign(new Error("unauthorized"), {
      responseBody: "Wrong API key provided: sk-ant-abcdef0123456789abcdef.",
    });
    expect(errorDetail(err)).toContain("[redacted-token]");
    expect(errorDetail(err)).not.toContain("abcdef0123456789");
  });
});

describe("redaction of what a gateway echoes back", () => {
  it("redacts a JSON-encoded Authorization header", () => {
    const out = redactSecrets('{"headers":{"authorization":"Bearer ya29.a0AfH6SMBxxxxxxxx"}}');
    expect(out).not.toContain("ya29");
    expect(out).toContain("[redacted]");
  });

  it("redacts a credential named as one, whatever its shape", () => {
    expect(redactSecrets('"access_token": "eyJhbGciOiJIUzI1NiJ9.payload"')).not.toContain("eyJ");
    expect(redactSecrets("x-api-key: 9f3c1d2e4b5a6789")).not.toContain("9f3c1d2e");
  });

  it("keeps the endpoint but not a credential in its query string", () => {
    const err = Object.assign(new Error("bad request"), {
      statusCode: 400,
      url: "https://gateway.internal/v1beta/models/x:stream?key=AIzaSyFAKEKEY123456",
    });
    const detail = errorDetail(err);
    expect(detail).toContain("https://gateway.internal/v1beta/models/x:stream");
    expect(detail).not.toContain("AIzaSy");
  });

  it("never serializes the request the SDK attached to the error", () => {
    // `requestBodyValues` is the whole outbound conversation, headers included.
    const thrown = { requestBodyValues: { messages: [{ content: "private notes" }] }, code: 400 };
    expect(errorDetail(thrown)).not.toContain("private notes");
    expect(errorDetail(thrown)).toContain("400");
  });
});
