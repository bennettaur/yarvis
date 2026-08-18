import { describe, expect, it } from "bun:test";
import { connectionError } from "./service.ts";

/**
 * How a failed connect is described to the user. Pure — no DB, no network.
 */
describe("connectionError", () => {
  it("carries the cause, which is where the useful half lives", () => {
    // The MCP client library reports a response its schema rejected as a bare
    // "Failed to parse server response" and puts what was actually wrong in the
    // cause, so reporting only the message tells the user nothing.
    const error = new Error("Failed to parse server response", {
      cause: new Error("tools.0.inputSchema.type: expected 'object', received undefined"),
    });
    expect(connectionError(error)).toBe(
      "Failed to parse server response: tools.0.inputSchema.type: expected 'object', received undefined",
    );
  });

  it("is just the message when there is no cause", () => {
    expect(connectionError(new Error("fetch failed"))).toBe("fetch failed");
  });

  it("keeps the http status the client library attaches", () => {
    const error = Object.assign(new Error("Forbidden"), { statusCode: 403 });
    expect(connectionError(error)).toBe("Forbidden (status 403)");
  });

  it("redacts credentials that a server echoed back into its complaint", () => {
    const error = new Error("bad response", {
      cause: new Error("rejected authorization: Bearer sk-ant-abcdef0123456789xyz"),
    });
    const message = connectionError(error);
    expect(message).not.toContain("sk-ant-abcdef0123456789xyz");
    expect(message).toBe("bad response: rejected authorization: Bearer [redacted]");
  });

  it("redacts a bare token that isn't behind an authorization header", () => {
    const error = new Error("bad response", {
      cause: new Error("unknown key ghp_abcdefghij0123456789 in payload"),
    });
    expect(connectionError(error)).toBe("bad response: unknown key [redacted-token] in payload");
  });

  it("bounds a cause long enough to swamp the UI", () => {
    const error = new Error("bad response", { cause: new Error("x".repeat(1000)) });
    // The prefix plus the 300-character cap, and nothing like the full 1000.
    expect(connectionError(error).length).toBe("bad response: ".length + 300);
  });

  it("survives something thrown that isn't an Error", () => {
    expect(connectionError("plain string")).toBe("plain string");
  });
});
