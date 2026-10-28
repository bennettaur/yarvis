import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import net from "node:net";
import { brotliCompressSync, gzipSync } from "node:zlib";
import {
  CrossOriginRedirectError,
  createPinnedFetch,
  guardedFetch,
  readCapped,
} from "./guardedFetch.ts";
import { createSafeLookup, UrlSafetyError } from "./urlSafety.ts";

/** A local server that records what reached it. */
let server: ReturnType<typeof Bun.serve>;
const seen: { path: string; contentType: string | null; model: string | null }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const contentType = req.headers.get("content-type");
      if (path === "/form") {
        const form = await req.formData();
        seen.push({ path, contentType, model: String(form.get("model")) });
        return new Response("ok");
      }
      seen.push({ path, contentType, model: null });
      if (path === "/gzip") {
        return new Response(gzipSync("compressed hello"), {
          headers: { "content-encoding": "gzip", "content-type": "text/plain" },
        });
      }
      if (path === "/empty") return new Response(null, { status: 204 });
      if (path === "/stacked") {
        return new Response(brotliCompressSync(gzipSync("twice compressed")), {
          headers: { "content-encoding": "gzip, br" },
        });
      }
      if (path === "/odd-encoding") {
        return new Response("plain", { headers: { "content-encoding": "constructor" } });
      }
      if (path === "/see-other") {
        seen.push({ path: `${path}:${req.method}`, contentType, model: null });
        return new Response(null, { status: 303, headers: { location: "/result" } });
      }
      if (path === "/result") return new Response(`result via ${req.method}`);
      if (path === "/slow") {
        // Sends one chunk, then stalls, so only an abort can end the read.
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
            },
          }),
        );
      }
      return new Response(`hello from ${path}`);
    },
  });
});

afterAll(() => server.stop());

const local = (path: string) => `http://127.0.0.1:${server.port}${path}`;

/** A TCP server that answers every connection with `raw`, for replies `Bun.serve` won't send. */
async function rawServer(raw: string, { hang = false } = {}) {
  const sockets = new Set<net.Socket>();
  const tcp = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("data", () => {
      socket.write(raw);
      if (!hang) socket.end();
    });
  });
  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", () => resolve()));
  const { port } = tcp.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      tcp.close();
    },
  };
}

describe("createPinnedFetch", () => {
  it("refuses a host whose DNS answer is private, without connecting", async () => {
    // What a rebinding host does on its second answer: a name that passed a
    // check now resolves to loopback.
    const pinned = createPinnedFetch({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    const before = seen.length;
    const error = await pinned(`http://rebind.test:${server.port}/secret`).catch((e) => e);
    expect(error).toBeInstanceOf(UrlSafetyError);
    expect(seen.length).toBe(before);
  });

  it("refuses when any one of a host's addresses is private", async () => {
    const pinned = createPinnedFetch({
      resolve: async () => [
        { address: "203.0.113.10", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
    });
    await expect(pinned("http://mixed.test/")).rejects.toBeInstanceOf(UrlSafetyError);
  });

  it("connects to loopback only when the caller allows it", async () => {
    const pinned = createPinnedFetch({
      allowLoopback: true,
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    const res = await pinned(`http://speech.test:${server.port}/ok`);
    expect(await res.text()).toBe("hello from /ok");
  });

  it("sends a FormData body with its multipart Content-Type", async () => {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), "a.webm");
    form.set("model", "whisper-1");
    const pinned = createPinnedFetch({ allowLoopback: true });
    const res = await pinned(local("/form"), { method: "POST", headers: {}, body: form });
    expect(res.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ path: "/form", model: "whisper-1" });
    expect(seen.at(-1)?.contentType).toStartWith("multipart/form-data; boundary=");
  });

  it("decompresses a gzip body the way fetch does", async () => {
    const res = await createPinnedFetch({ allowLoopback: true })(local("/gzip"));
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe("compressed hello");
  });

  it("answers a HEAD request with an empty body despite its Content-Length", async () => {
    const res = await createPinnedFetch({ allowLoopback: true })(local("/ok"), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("undoes stacked encodings in reverse order", async () => {
    const res = await createPinnedFetch({ allowLoopback: true })(local("/stacked"));
    expect(await res.text()).toBe("twice compressed");
  });

  it("answers a no-content status with an empty body", async () => {
    const res = await createPinnedFetch({ allowLoopback: true })(local("/empty"));
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it("refuses a private IP literal, which never reaches a lookup", async () => {
    const before = seen.length;
    await expect(createPinnedFetch()(local("/ok"))).rejects.toBeInstanceOf(UrlSafetyError);
    expect(seen.length).toBe(before);
  });

  it("ends a body read when the caller aborts", async () => {
    const controller = new AbortController();
    const res = await createPinnedFetch({ allowLoopback: true })(local("/slow"), {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const started = performance.now();
    await expect(readCapped(res, 1024)).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("createPinnedFetch against a hostile server", () => {
  const pinned = createPinnedFetch({ allowLoopback: true });

  it("rejects a status Response can't hold instead of crashing", async () => {
    const raw = await rawServer("HTTP/1.1 699 Weird\r\nContent-Length: 0\r\n\r\n");
    try {
      await expect(pinned(raw.url)).rejects.toThrow("invalid status (699)");
    } finally {
      raw.close();
    }
  });

  it("treats an encoding it doesn't know as no encoding, even one named like a prototype key", async () => {
    const res = await pinned(local("/odd-encoding"));
    expect(await res.text()).toBe("plain");
  });

  it("fails a body that ends before its Content-Length", async () => {
    const raw = await rawServer("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort");
    try {
      const res = await pinned(raw.url);
      await expect(readCapped(res, 1024)).rejects.toThrow();
    } finally {
      raw.close();
    }
  });

  it("ends a stalled gzip body when the caller aborts", async () => {
    const partial = gzipSync("x".repeat(10_000)).subarray(0, 20);
    const raw = await rawServer(
      `HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 9999\r\n\r\n${partial.toString("latin1")}`,
      { hang: true },
    );
    try {
      const controller = new AbortController();
      const res = await pinned(raw.url, { signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      const started = performance.now();
      await expect(readCapped(res, 1_000_000)).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      raw.close();
    }
  });
});

describe("createSafeLookup", () => {
  type Answer = { err: Error | null; address: unknown; family?: number };
  const ask = (lookup: ReturnType<typeof createSafeLookup>, all: boolean) =>
    new Promise<Answer>((resolve) =>
      lookup("host.test", { all }, (err, address, family) => resolve({ err, address, family })),
    );

  it("hands back every checked address in the shape the caller asked for", async () => {
    const lookup = createSafeLookup({
      resolve: async () => [
        { address: "203.0.113.10", family: 4 },
        { address: "2001:db8::1", family: 6 },
      ],
    });
    expect((await ask(lookup, true)).address).toEqual([
      { address: "203.0.113.10", family: 4 },
      { address: "2001:db8::1", family: 6 },
    ]);
    expect(await ask(lookup, false)).toMatchObject({
      err: null,
      address: "203.0.113.10",
      family: 4,
    });
  });

  it("refuses a private IPv6 answer", async () => {
    const lookup = createSafeLookup({ resolve: async () => [{ address: "fd00::1", family: 6 }] });
    expect((await ask(lookup, true)).err).toBeInstanceOf(UrlSafetyError);
  });

  it("allows loopback when asked, but not another private address beside it", async () => {
    const lookup = createSafeLookup({
      allowLoopback: true,
      resolve: async () => [
        { address: "127.0.0.1", family: 4 },
        { address: "192.168.1.5", family: 4 },
      ],
    });
    expect((await ask(lookup, true)).err).toBeInstanceOf(UrlSafetyError);
  });

  it("refuses an empty answer and a failed lookup", async () => {
    const empty = createSafeLookup({ resolve: async () => [] });
    expect((await ask(empty, true)).err).toBeInstanceOf(UrlSafetyError);
    const failing = createSafeLookup({
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect((await ask(failing, true)).err?.message).toBe("dns lookup failed for host.test");
  });
});

describe("guardedFetch", () => {
  // Literal public addresses, so the per-hop guard passes without DNS.
  const FIRST = "https://203.0.113.10/start";
  const OTHER_SITE = "https://203.0.113.11/landing";

  function redirecting(to: string) {
    const sent: { url: string; headers: Headers }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      sent.push({ url, headers: new Headers(init?.headers) });
      return url === FIRST
        ? new Response(null, { status: 307, headers: { location: to } })
        : new Response("done");
    }) as typeof fetch;
    return { fetchImpl, sent };
  }

  it("drops the caller's headers when a redirect leaves the original site", async () => {
    const { fetchImpl, sent } = redirecting(OTHER_SITE);
    await guardedFetch(
      FIRST,
      { headers: { "x-api-key": "secret", "user-agent": "yarvis" } },
      { fetchImpl },
    );
    expect(sent[0]?.headers.get("x-api-key")).toBe("secret");
    expect(sent[1]?.url).toBe(OTHER_SITE);
    expect(sent[1]?.headers.get("x-api-key")).toBeNull();
    expect(sent[1]?.headers.get("user-agent")).toBe("yarvis");
  });

  it("keeps them on a redirect within the same site", async () => {
    const { fetchImpl, sent } = redirecting("/elsewhere");
    await guardedFetch(FIRST, { headers: { "x-api-key": "secret" } }, { fetchImpl });
    expect(sent[1]?.headers.get("x-api-key")).toBe("secret");
  });

  it("follows a 303 after a POST as a GET, without the body", async () => {
    const { response } = await guardedFetch(
      local("/see-other"),
      { method: "POST", body: "audio" },
      { allowLoopback: true },
    );
    expect(await response.text()).toBe("result via GET");
  });

  it("refuses to send a request body to another site", async () => {
    const { fetchImpl, sent } = redirecting(OTHER_SITE);
    const request = guardedFetch(FIRST, { method: "POST", body: "recorded audio" }, { fetchImpl });
    await expect(request).rejects.toBeInstanceOf(CrossOriginRedirectError);
    expect(sent.length).toBe(1);
  });

  it("refuses a loopback URL unless the caller allows it", async () => {
    await expect(guardedFetch(local("/ok"), {})).rejects.toBeInstanceOf(UrlSafetyError);
    const { response } = await guardedFetch(local("/ok"), {}, { allowLoopback: true });
    expect(await response.text()).toBe("hello from /ok");
  });
});

describe("readCapped", () => {
  it("reads a body under the cap and refuses one over it", async () => {
    expect(new TextDecoder().decode(await readCapped(new Response("abc"), 3))).toBe("abc");
    await expect(readCapped(new Response("abcd"), 3)).rejects.toThrow("larger than 3 bytes");
  });
});
