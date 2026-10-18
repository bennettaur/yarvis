import { describe, expect, it } from "bun:test";
import { GitHubDeviceFlow, githubClientId } from "./deviceFlow.ts";

type Reply = Record<string, unknown>;

/** A fake GitHub that answers the device-code request, then each token poll in turn. */
function fakeGitHub(tokenReplies: Reply[]) {
  const requests: { path: string; form: URLSearchParams }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push({ path, form: new URLSearchParams(String(init?.body)) });
    const body =
      path === "/login/device/code"
        ? {
            device_code: "dev-123",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          }
        : (tokenReplies.shift() ?? { error: "authorization_pending" });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

/** Runs the flow to its end with no real waiting, recording each wait. */
async function runFlow(tokenReplies: Reply[], saveToken = async (_token: string) => {}) {
  const github = fakeGitHub(tokenReplies);
  const waits: number[] = [];
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const flow = new GitHubDeviceFlow({
    clientId: "client-abc",
    fetchImpl: github.fetchImpl,
    saveToken,
    sleep: async (ms) => {
      waits.push(ms);
      if (waits.length > 10) finish();
    },
  });
  const start = await flow.start();
  for (let i = 0; i < 50 && flow.status(start.id)?.state === "pending"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  finish();
  await done.catch(() => {});
  return { flow, start, waits, requests: github.requests };
}

describe("GitHubDeviceFlow", () => {
  it("asks for a code with only the public client ID", async () => {
    const { start, requests } = await runFlow([{ access_token: "gho_x" }]);
    expect(start.userCode).toBe("ABCD-1234");
    expect(start.verificationUri).toBe("https://github.com/login/device");
    const codeRequest = requests[0];
    expect(codeRequest?.path).toBe("/login/device/code");
    expect(codeRequest?.form.get("client_id")).toBe("client-abc");
    expect(codeRequest?.form.get("scope")).toBe("repo read:org");
    expect(codeRequest?.form.has("client_secret")).toBe(false);
  });

  it("saves the token once the user approves", async () => {
    const saved: string[] = [];
    const { flow, start } = await runFlow(
      [{ error: "authorization_pending" }, { access_token: "gho_secret" }],
      async (token) => {
        saved.push(token);
      },
    );
    expect(saved).toEqual(["gho_secret"]);
    expect(flow.status(start.id)).toEqual({ state: "authorized" });
  });

  it("waits longer when GitHub says to slow down", async () => {
    const { waits } = await runFlow([
      { error: "slow_down", interval: 10 },
      { access_token: "gho_x" },
    ]);
    expect(waits.slice(0, 2)).toEqual([5000, 10000]);
  });

  it("reports a denial", async () => {
    const { flow, start } = await runFlow([{ error: "access_denied" }]);
    expect(flow.status(start.id)).toEqual({ state: "denied" });
  });

  it("explains a device flow turned off on the OAuth App", async () => {
    const { flow, start } = await runFlow([{ error: "device_flow_disabled" }]);
    const status = flow.status(start.id);
    expect(status?.state).toBe("failed");
    expect(status && "error" in status ? status.error : "").toContain("Enable it");
  });

  it("reports a failure to save the token instead of claiming success", async () => {
    const { flow, start } = await runFlow([{ access_token: "gho_x" }], async () => {
      throw new Error("keychain locked");
    });
    const status = flow.status(start.id);
    expect(status?.state).toBe("failed");
    expect(status && "error" in status ? status.error : "").toContain("keychain locked");
  });

  it("forgets a cancelled sign-in", async () => {
    const github = fakeGitHub([]);
    const flow = new GitHubDeviceFlow({
      clientId: "client-abc",
      fetchImpl: github.fetchImpl,
      saveToken: async () => {},
      sleep: () => new Promise(() => {}),
    });
    const start = await flow.start();
    flow.cancel(start.id);
    expect(flow.status(start.id)).toBeNull();
  });
});

describe("githubClientId", () => {
  it("lets a build point at its own OAuth App", () => {
    expect(githubClientId({ YARVIS_GITHUB_CLIENT_ID: " other-app " })).toBe("other-app");
  });
});
