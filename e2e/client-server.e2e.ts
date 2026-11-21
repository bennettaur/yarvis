import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { setupCode, startServer, type TestServer } from "./server";

/**
 * The client-server build end to end: a real yarvis-server serving the built
 * web UI to Chromium, with a virtual passkey. The sidecar is off, so the
 * panels that need it show their errors; what is checked is the server's own
 * surface: sign-in, devices, terminals, events and the vault's git signing.
 */

const TOKEN_KEY = "yarvis.deviceToken";

let server: TestServer;
// One page for the whole run: the virtual passkey lives in its context.
let context: BrowserContext;
let page: Page;
const cspViolations: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  server = await startServer();
  context = await browser.newContext();
  page = await context.newPage();
  // Chromium logs most violations, but the event catches every one.
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      console.error(
        `Content Security Policy violation: ${e.violatedDirective} blocked ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}`,
      );
    });
  });
  page.on("console", (msg) => {
    if (/Content Security Policy/i.test(msg.text())) cspViolations.push(msg.text());
  });
  await addPasskeyAuthenticator(page);
});

// Checked after every test, so a CSP regression shows even when a later step fails.
test.afterEach(() => {
  expect(cspViolations).toEqual([]);
});

test.afterAll(async () => {
  await context?.close();
  await server?.stop();
});

/** A platform authenticator that holds resident keys and verifies the user, like Touch ID. */
async function addPasskeyAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function deviceToken(page: Page): Promise<string> {
  const token = await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY);
  if (!token) throw new Error("no device token in localStorage");
  return token;
}

async function api(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.origin}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * Past the boot screen into the app. The sidecar is off, so the boot screen
 * waits for it until it offers "Continue anyway".
 */
async function enterApp() {
  const nav = page.getByRole("navigation").first();
  const skip = page.getByRole("button", { name: "Continue anyway" });
  await expect(nav.or(skip)).toBeVisible({ timeout: 15_000 });
  if (await skip.isVisible()) await skip.click();
  await expect(nav).toBeVisible();
}

async function openSettingsTab(page: Page, tab: string) {
  await page
    .getByRole("navigation")
    .first()
    .getByRole("button", { name: /^Settings( —|$)/ })
    .click();
  await page.getByRole("button", { name: tab, exact: true }).click();
}

test("passkey setup and sign-in", async () => {
  await page.goto(server.origin);

  await page.getByLabel("Setup code").fill(setupCode(server));
  await page.getByRole("button", { name: "Create passkey" }).click();

  // The vault starts locked; the app waits for it.
  await expect(page.getByText("The server's vault is locked")).toBeVisible();
  await page.getByLabel("Recovery key").fill(server.recoveryKey);
  await page.getByRole("button", { name: "Unlock with recovery key" }).click();
  await enterApp();

  // Sign out by dropping the token, then sign in with the resident passkey.
  await page.evaluate((key) => localStorage.removeItem(key), TOKEN_KEY);
  await page.reload();
  await page.getByRole("button", { name: "Sign in" }).click();
  await enterApp();
  const token = await deviceToken(page);
  const me = await api(token, "GET", "/api/devices/me");
  expect(me.body.scopes).toEqual(["read", "chat", "terminal", "approve", "admin"]);
});

test("devices: mint a read-only token and revoke it", async () => {
  await openSettingsTab(page, "Devices");

  await page.getByLabel("Name").fill("Dashboard");
  // `read` and `chat` start ticked.
  await page.getByRole("checkbox", { name: /^chat/ }).uncheck();
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByRole("button", { name: "Done" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  const row = page.getByRole("listitem").filter({ hasText: "Dashboard" });
  await expect(row).toContainText("Token · read");
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Dashboard" })).toHaveCount(0);
});

test("terminal: run a command, then resume the scrollback after a reload", async () => {
  await page
    .getByRole("navigation")
    .first()
    .getByRole("button", { name: /^Terminal( —|$)/ })
    .click();
  const terminal = page.locator(".xterm").filter({ visible: true }).first();
  // Keys typed before the shell is attached would be lost.
  await expect(terminal).toContainText("$");
  await terminal.click();
  // The marker is split so the echoed command line can't match the output.
  await page.keyboard.type("echo hel''lo-e2e");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("hello-e2e");
  // Shells get the server's agent socket from AppState, even while it's locked.
  await page.keyboard.type("echo sock=$SSH_AUTH_SOCK");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(`sock=${join(server.dataDir, "ssh-agent.sock")}`);

  await page.reload();
  await enterApp();
  const resumed = page.locator(".xterm").filter({ visible: true }).first();
  await expect(resumed).toContainText("hello-e2e");
});

test("events: a second device sees device.revoked", async () => {
  const admin = await deviceToken(page);
  const watcher = await api(admin, "POST", "/api/devices/tokens", {
    name: "watcher",
    scopes: ["read"],
  });
  expect(watcher.status).toBe(200);
  const doomed = await api(admin, "POST", "/api/devices/tokens", {
    name: "doomed",
    scopes: ["read"],
  });

  // `since: 0` replays the log first and then streams live, with nothing
  // missed, so once the watcher's own creation arrives the socket is live.
  await page.evaluate(
    ({ token, origin }) => {
      const w = window as unknown as { e2eEvents: { kind: string; data: unknown }[] };
      w.e2eEvents = [];
      const socket = new WebSocket(`${origin.replace("http", "ws")}/api/events`);
      socket.onopen = () => socket.send(JSON.stringify({ type: "auth", token, since: 0 }));
      socket.onmessage = (e) => w.e2eEvents.push(JSON.parse(e.data));
    },
    { token: watcher.body.token, origin: server.origin },
  );
  const sawEvent = (kind: string, deviceId: string) =>
    page.waitForFunction(
      ({ kind, deviceId }) =>
        (
          window as unknown as { e2eEvents: { kind: string; data: { deviceId?: string } }[] }
        ).e2eEvents.some((e) => e.kind === kind && e.data.deviceId === deviceId),
      { kind, deviceId },
    );
  await sawEvent("device.created", watcher.body.device.deviceId);

  const revoked = await api(admin, "DELETE", `/api/devices/${doomed.body.device.deviceId}`);
  expect(revoked.status).toBe(200);
  await sawEvent("device.revoked", doomed.body.device.deviceId);
});

test("vault: sign a commit through the approvals box", async () => {
  const admin = await deviceToken(page);
  const agent = await api(admin, "GET", "/api/vault/ssh-agent");
  expect(agent.body.publicKey).toBe(server.signingKey);

  const repo = join(server.home, "repo");
  mkdirSync(repo);
  const allowedSigners = join(server.home, "allowed_signers");
  writeFileSync(allowedSigners, `e2e@example.com ${server.signingKey}\n`);
  const gitEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: server.home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    SSH_AUTH_SOCK: join(server.dataDir, "ssh-agent.sock"),
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, env: gitEnv, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "E2E");
  git("config", "user.email", "e2e@example.com");
  git("config", "gpg.format", "ssh");
  git("config", "gpg.ssh.allowedSignersFile", allowedSigners);
  // `key::` hands git the public key, so it signs through the agent.
  git("config", "user.signingkey", `key::${server.signingKey}`);

  const commit = new Promise<number>((done) => {
    const child = spawn("git", ["commit", "-q", "--allow-empty", "-S", "-m", "signed"], {
      cwd: repo,
      env: gitEnv,
    });
    child.on("exit", (code) => done(code ?? -1));
  });
  const box = page.locator("section").filter({ hasText: "Approvals" }).first();
  await expect(box).toContainText("git.sign");
  await box.getByRole("button", { name: "Approve" }).click();
  expect(await commit).toBe(0);
  // `G`: a good signature from a key in the allowed signers file.
  expect(git("log", "-1", "--format=%G?").trim()).toBe("G");
});
