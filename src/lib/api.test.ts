import { describe, expect, it } from "bun:test";
import { ensureOk } from "./api";

/**
 * `ensureOk` is what turns a bare "400" into an actionable message: it reads the
 * sidecar's error body and folds it into the thrown Error. These cases cover the
 * two body shapes the sidecar emits — a plain `{ error: string }` and a Zod
 * `flatten()` — plus the fallbacks for empty and non-JSON bodies.
 */
describe("ensureOk", () => {
  it("does nothing for an ok response", async () => {
    await ensureOk(new Response("{}", { status: 200 }), "op");
  });

  it("surfaces a string error body", async () => {
    const res = new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    await expect(ensureOk(res, "get thing")).rejects.toThrow("get thing failed (404): not found");
  });

  it("flattens a Zod fieldErrors body into a readable line", async () => {
    const res = new Response(
      JSON.stringify({
        error: {
          formErrors: [],
          fieldErrors: { baseUrl: ["refusing to reach a private address"] },
        },
      }),
      { status: 400 },
    );
    await expect(ensureOk(res, "create custom provider")).rejects.toThrow(
      "create custom provider failed (400): baseUrl: refusing to reach a private address",
    );
  });

  it("falls back to the bare status when the body is empty", async () => {
    await expect(ensureOk(new Response("", { status: 503 }), "status")).rejects.toThrow(
      "status failed: 503",
    );
  });

  it("surfaces a non-JSON body verbatim", async () => {
    const res = new Response("upstream exploded", { status: 502 });
    await expect(ensureOk(res, "proxy")).rejects.toThrow("proxy failed (502): upstream exploded");
  });
});
