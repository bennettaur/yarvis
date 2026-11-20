import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { disableIdleTimeout } from "./idleTimeout.ts";

describe("disableIdleTimeout", () => {
  it("keeps a quiet request open past the server's idle timeout", async () => {
    const app = new Hono();
    const quietFor = async () => Bun.sleep(12_000);
    app.get("/held", async (c) => {
      disableIdleTimeout(c);
      await quietFor();
      return c.text("held");
    });
    app.get("/plain", async (c) => {
      await quietFor();
      return c.text("plain");
    });
    // Bun checks idle sockets every few seconds, so the wait has to be well past 1s.
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 1 });
    try {
      const get = (path: string) =>
        fetch(`http://127.0.0.1:${server.port}${path}`)
          .then((r) => r.text())
          .catch(() => "closed");
      const [held, plain] = await Promise.all([get("/held"), get("/plain")]);
      expect(held).toBe("held");
      expect(plain).toBe("closed");
    } finally {
      server.stop(true);
    }
  }, 30_000);

  it("does nothing without a Bun server", async () => {
    const app = new Hono();
    app.get("/", (c) => {
      disableIdleTimeout(c);
      return c.text("ok");
    });
    expect(await (await app.request("/")).text()).toBe("ok");
  });
});
