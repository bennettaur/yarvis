import { describe, expect, it } from "bun:test";
import { BrowserBridge } from "./bridge.ts";
import { createBrowserRoutes } from "./routes.ts";

function setup() {
  const bridge = new BrowserBridge("browser-token");
  const app = createBrowserRoutes(bridge);
  const auth = { Authorization: "Bearer browser-token", "Content-Type": "application/json" };
  return { bridge, app, auth };
}

describe("browser bridge routes", () => {
  it("rejects every route without the scoped token", async () => {
    const { app } = setup();
    expect((await app.request("/next")).status).toBe(401);
    expect(
      (
        await app.request("/result", {
          method: "POST",
          body: JSON.stringify({ id: "x", ok: true }),
        })
      ).status,
    ).toBe(401);
    const wrong = { Authorization: "Bearer test-token" };
    expect((await app.request("/next", { headers: wrong })).status).toBe(401);
  });

  it("carries a command out and its result back", async () => {
    const { bridge, app, auth } = setup();
    const polled = app.request("/next", { headers: auth });
    // Let the poll reach the handler, which is what marks the extension connected.
    await Bun.sleep(10);
    const answer = bridge.request({ type: "list_tabs" });

    const res = await polled;
    expect(res.status).toBe(200);
    const { id, command } = (await res.json()) as { id: string; command: { type: string } };
    expect(command.type).toBe("list_tabs");

    const posted = await app.request("/result", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id, ok: true, data: [{ id: 1 }] }),
    });
    expect(await posted.json()).toEqual({ delivered: true });
    expect(await answer).toEqual({ ok: true, data: [{ id: 1 }] });
  });

  it("rejects a malformed result and an oversized one", async () => {
    const { app, auth } = setup();
    const bad = await app.request("/result", { method: "POST", headers: auth, body: "{}" });
    expect(bad.status).toBe(400);
    const notJson = await app.request("/result", { method: "POST", headers: auth, body: "nope" });
    expect(notJson.status).toBe(400);

    const big = await app.request("/result", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "x", ok: true, data: "a".repeat(2_100_000) }),
    });
    expect(big.status).toBe(413);
  });

  it("reports a result for an unknown command as undelivered", async () => {
    const { app, auth } = setup();
    const res = await app.request("/result", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "gone", ok: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivered: false });
  });
});
