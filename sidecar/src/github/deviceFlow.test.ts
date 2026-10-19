import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createGithubAuthRoutes } from "./authRoutes.ts";
import { GitHubDeviceFlow, githubClientId } from "./deviceFlow.ts";

type Reply = Record<string, unknown> | Response;

const DEVICE_CODE_REPLY = {
  device_code: "dev-123",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

/**
 * A fake GitHub that answers the device-code request, then each token poll in
 * turn. Once the replies run out it denies, so no poll loop outlives its test.
 */
function fakeGitHub(tokenReplies: Reply[], deviceCodeReply: Reply = DEVICE_CODE_REPLY) {
  const requests: { path: string; form: URLSearchParams }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push({ path, form: new URLSearchParams(String(init?.body)) });
    const reply =
      path === "/login/device/code"
        ? deviceCodeReply
        : (tokenReplies.shift() ?? { error: "access_denied" });
    return reply instanceof Response ? reply : new Response(JSON.stringify(reply));
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

interface FlowOptions {
  deviceCodeReply?: Reply;
  saveToken?: (token: string) => Promise<void>;
  lookupLogin?: (token: string) => Promise<string>;
  now?: () => number;
}

/**
 * A flow whose waits take one tick rather than seconds. A tick, not nothing,
 * so the test gets to act between polls.
 */
function makeFlow(tokenReplies: Reply[], options: FlowOptions = {}) {
  const github = fakeGitHub(tokenReplies, options.deviceCodeReply);
  const saved: string[] = [];
  const waits: number[] = [];
  const flow = new GitHubDeviceFlow({
    clientId: "client-abc",
    fetchImpl: github.fetchImpl,
    saveToken:
      options.saveToken ??
      (async (token) => {
        saved.push(token);
      }),
    lookupLogin: options.lookupLogin,
    now: options.now,
    sleep: (ms) => {
      waits.push(ms);
      return new Promise((resolve) => setTimeout(resolve, 0));
    },
  });
  return { flow, saved, waits, requests: github.requests };
}

/** Lets the background poll loop run until the sign-in leaves `pending`. */
async function settle(flow: GitHubDeviceFlow, id: string) {
  for (let i = 0; i < 100 && flow.status(id)?.state === "pending"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return flow.status(id);
}

describe("GitHubDeviceFlow", () => {
  it("asks for a code with only the public client ID", async () => {
    const { flow, requests } = makeFlow([]);
    const started = await flow.start();
    expect(started.userCode).toBe("ABCD-1234");
    expect(started.verificationUri).toBe("https://github.com/login/device");
    const codeRequest = requests[0];
    expect(codeRequest?.path).toBe("/login/device/code");
    expect(codeRequest?.form.get("client_id")).toBe("client-abc");
    expect(codeRequest?.form.get("scope")).toBe("repo read:org");
    expect(codeRequest?.form.has("client_secret")).toBe(false);
  });

  it("keeps the user on github.com whatever page GitHub's reply names", async () => {
    for (const verification_uri of [
      "https://evil.example/login/device",
      "http://github.com/login/device",
      42,
    ]) {
      const { flow } = makeFlow([], {
        deviceCodeReply: { ...DEVICE_CODE_REPLY, verification_uri },
      });
      expect((await flow.start()).verificationUri).toBe("https://github.com/login/device");
    }
  });

  it("rejects with GitHub's description when no device code comes back", async () => {
    const { flow } = makeFlow([], {
      deviceCodeReply: { error: "unsupported", error_description: "bad client" },
    });
    await expect(flow.start()).rejects.toThrow("bad client");
  });

  it("saves the token once the user approves, and reports who signed in", async () => {
    const { flow, saved } = makeFlow(
      [{ error: "authorization_pending" }, { access_token: "gho_secret" }],
      { lookupLogin: async () => "octocat" },
    );
    const started = await flow.start();
    expect(await settle(flow, started.id)).toEqual({ state: "authorized", login: "octocat" });
    expect(saved).toEqual(["gho_secret"]);
  });

  it("still signs in when looking up the login fails", async () => {
    const { flow } = makeFlow([{ access_token: "gho_x" }], {
      lookupLogin: async () => {
        throw new Error("rate limited");
      },
    });
    const started = await flow.start();
    expect(await settle(flow, started.id)).toEqual({ state: "authorized", login: null });
  });

  it("waits longer when GitHub says to slow down", async () => {
    const { flow, waits } = makeFlow([{ error: "slow_down", interval: 10 }, { access_token: "x" }]);
    const started = await flow.start();
    await settle(flow, started.id);
    expect(waits).toEqual([5000, 10000]);
  });

  it("keeps polling through a failed request", async () => {
    const { flow, saved } = makeFlow([
      new Response("oops", { status: 502 }),
      { access_token: "x" },
    ]);
    const started = await flow.start();
    expect((await settle(flow, started.id))?.state).toBe("authorized");
    expect(saved).toEqual(["x"]);
  });

  it("reports a denial", async () => {
    const { flow } = makeFlow([{ error: "access_denied" }]);
    const started = await flow.start();
    expect(await settle(flow, started.id)).toEqual({ state: "denied" });
  });

  it("reports expiry when GitHub says the code expired", async () => {
    const { flow } = makeFlow([{ error: "expired_token" }]);
    const started = await flow.start();
    expect(await settle(flow, started.id)).toEqual({ state: "expired" });
  });

  it("stops polling once the code's lifetime has passed", async () => {
    let now = 0;
    const { flow, requests } = makeFlow([], { now: () => now });
    const started = await flow.start();
    now = 901_000;
    expect(await settle(flow, started.id)).toEqual({ state: "expired" });
    expect(requests.map((r) => r.path)).toEqual(["/login/device/code"]);
  });

  it("explains a device flow turned off on the OAuth App", async () => {
    const { flow } = makeFlow([{ error: "device_flow_disabled" }]);
    const started = await flow.start();
    const status = await settle(flow, started.id);
    expect(status?.state).toBe("failed");
    expect(status && "error" in status ? status.error : "").toContain("Enable it");
  });

  it("reports a failure to save the token instead of claiming success", async () => {
    const { flow } = makeFlow([{ access_token: "gho_x" }], {
      saveToken: async () => {
        throw new Error("keychain locked");
      },
    });
    const started = await flow.start();
    const status = await settle(flow, started.id);
    expect(status?.state).toBe("failed");
    expect(status && "error" in status ? status.error : "").toContain("keychain locked");
  });

  it("never saves the token of a cancelled sign-in", async () => {
    const { flow, saved, requests } = makeFlow([{ access_token: "gho_x" }]);
    const started = await flow.start();
    flow.cancel(started.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flow.status(started.id)).toBeNull();
    expect(saved).toEqual([]);
    expect(requests.map((r) => r.path)).toEqual(["/login/device/code"]);
  });

  it("stops the previous sign-in when a new one starts", async () => {
    const { flow, saved } = makeFlow([{ access_token: "only-one" }]);
    const first = await flow.start();
    const second = await flow.start();
    await settle(flow, second.id);
    expect(flow.status(first.id)).toBeNull();
    // One token was issued, and only the current sign-in may save it.
    expect(saved).toEqual(["only-one"]);
    expect(flow.status(second.id)?.state).toBe("authorized");
  });
});

describe("GitHub sign-in routes", () => {
  function app(deviceFlow: GitHubDeviceFlow | null) {
    return new Hono().route("/", createGithubAuthRoutes({}, deviceFlow));
  }

  it("turns sign-in off when the GitHub API is overridden", async () => {
    const routes = new Hono().route(
      "/",
      createGithubAuthRoutes({ endpoints: { githubApi: "http://127.0.0.1:9/api" } }),
    );
    expect(await (await routes.request("/")).json()).toEqual({ configured: false });
  });

  it("says sign-in is off, and refuses to start, when no client ID is set", async () => {
    const routes = app(null);
    expect(await (await routes.request("/")).json()).toEqual({ configured: false });
    const res = await routes.request("/device", { method: "POST" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { reason: string }).reason).toBe("not_configured");
  });

  it("returns the code to show, and reports the outcome by id", async () => {
    const { flow } = makeFlow([{ access_token: "x" }]);
    const routes = app(flow);
    const started = (await (await routes.request("/device", { method: "POST" })).json()) as {
      id: string;
      userCode: string;
    };
    expect(started.userCode).toBe("ABCD-1234");
    await settle(flow, started.id);
    expect(await (await routes.request(`/device/${started.id}`)).json()).toEqual({
      state: "authorized",
      login: null,
    });
  });

  it("502s with GitHub's reason when GitHub refuses the client ID", async () => {
    const { flow } = makeFlow([], { deviceCodeReply: { error: "incorrect_client_credentials" } });
    const res = await app(flow).request("/device", { method: "POST" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("client ID");
  });

  it("404s a sign-in it doesn't know", async () => {
    const { flow } = makeFlow([]);
    expect((await app(flow).request("/device/nope")).status).toBe(404);
  });
});

describe("githubClientId", () => {
  it("lets a build point at its own OAuth App", () => {
    expect(githubClientId({ YARVIS_GITHUB_CLIENT_ID: " other-app " })).toBe("other-app");
  });

  it("falls back to the built-in app when the variable is blank", () => {
    expect(githubClientId({ YARVIS_GITHUB_CLIENT_ID: "  " })).toBe("Ov23li5eiMR2dElA7v2T");
  });
});
