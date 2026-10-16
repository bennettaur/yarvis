import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";
import { createPinnedFetch, guardedFetch, readCapped } from "./guardedFetch.ts";
import { UrlSafetyError } from "./urlSafety.ts";

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
      return new Response(`hello from ${path}`);
    },
  });
});

afterAll(() => server.stop());

const local = (path: string) => `http://127.0.0.1:${server.port}${path}`;

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

  it("answers a no-content status with an empty body", async () => {
    const res = await createPinnedFetch({ allowLoopback: true })(local("/empty"));
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });
});

describe("guardedFetch", () => {
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
