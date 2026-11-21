import { ensureOk, SidecarError } from "./api";
import { saveDeviceToken, serverFetch } from "./server";

/**
 * Client for the server's sign-in, account, devices and approvals routes
 * (`docs/client-server.md`). A device is one signed-in client or one token
 * minted for a script; each carries its own scopes and can be revoked alone.
 */

export type Scope = "read" | "chat" | "terminal" | "approve" | "admin";
/**
 * What a token minted from Settings can carry. The server keeps `admin` and
 * `terminal` (a shell on the server) for signed-in devices and its own CLI.
 */
export const MINTABLE_SCOPES: readonly Scope[] = ["read", "chat", "approve"];

/** What each scope lets a device do, as the Devices tab shows it. */
export const SCOPE_LABELS: Record<Scope, string> = {
  read: "see data and events",
  chat: "chat and drive workspaces",
  terminal: "open terminals",
  approve: "answer approvals",
  admin: "manage devices and secrets",
};

/** The shortest passphrase the server takes, for sign-in and the vault alike. */
export const MIN_PASSPHRASE_CHARS = 12;

export interface AuthStatus {
  setupRequired: boolean;
  /** `absent` when the server keeps its secrets somewhere other than its vault. */
  vault: "absent" | "uninitialized" | "locked" | "unlocked";
}

/** A device as the server returns it. Times are milliseconds since the epoch. */
export interface Device {
  deviceId: string;
  name: string;
  scopes: Scope[];
  verifiedAt?: number | null;
  /** The devices list adds these. `login` is a passphrase sign-in. */
  kind?: "login" | "token";
  createdAt?: number;
  lastSeenAt?: number | null;
  revokedAt?: number | null;
}

export interface SignedIn {
  token: string;
  device: Device;
}

async function post<T>(path: string, body: unknown, context: string): Promise<T> {
  const res = await serverFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  await ensureOk(res, context);
  return (await res.json()) as T;
}

async function get<T>(path: string, context: string): Promise<T> {
  const res = await serverFetch(path);
  await ensureOk(res, context);
  return (await res.json()) as T;
}

export const getAuthStatus = () => get<AuthStatus>("/api/auth/status", "auth status");

/* ---------- Setup and sign-in ---------- */

/** A new TOTP secret, waiting for its first code. */
export interface Enrollment {
  enrollmentId: string;
  /** The secret in base32, for typing into an authenticator app by hand. */
  secret: string;
  otpauthUri: string;
  /** The URI as a QR code: an SVG document. */
  qrSvg: string;
}

export interface SetUp extends SignedIn {
  /** Shown once. The server keeps only hashes. */
  backupCodes: string[];
}

/** First run: checks the setup code and passphrase, and starts the TOTP enrollment. */
export const startSetup = (code: string, passphrase: string, deviceName: string) =>
  post<Enrollment>("/api/auth/setup/start", { code, passphrase, deviceName }, "start setup");

/**
 * Ends setup with the first code from the authenticator app. The token isn't
 * kept yet: the caller saves it once the backup codes have been shown, since
 * saving it signs this client in and moves on from the setup screen.
 */
export const finishSetup = (enrollmentId: string, code: string) =>
  post<SetUp>("/api/auth/setup/finish", { enrollmentId, code }, "finish setup");

/** A code from the authenticator app, or one of the backup codes. */
export type SecondFactor = { code: string } | { backupCode: string };

/** Signs in; the server makes this client a new device. */
export async function signIn(
  passphrase: string,
  factor: SecondFactor,
  deviceName: string,
): Promise<SignedIn> {
  const signedIn = await post<SignedIn>(
    "/api/auth/login",
    { passphrase, ...factor, deviceName },
    "sign in",
  );
  saveDeviceToken(signedIn.token);
  return signedIn;
}

/* ---------- Fresh ---------- */

/** Makes this device fresh with a code from the authenticator app. */
export const reverify = (code: string) =>
  post<{ verifiedAt: number }>("/api/auth/reverify", { code }, "check the code");

/** What the server says when an action needs a code from the last 10 minutes. */
const REAUTH_REQUIRED = "reauth_required";

/**
 * Asks the user for a code from their authenticator app. Resolves null when
 * they cancel. The app shell registers one (see `CodePrompt`); with none, an
 * action that needs a recent code just fails.
 */
export type CodePrompter = () => Promise<string | null>;
let prompter: CodePrompter | null = null;

/** Registers the prompt. Returns a function that removes it. */
export function setCodePrompter(next: CodePrompter): () => void {
  prompter = next;
  return () => {
    if (prompter === next) prompter = null;
  };
}

const needsFreshCode = (e: unknown) =>
  e instanceof SidecarError && e.status === 403 && e.message.endsWith(REAUTH_REQUIRED);

/**
 * Runs an action the server guards with a recent code (device and account
 * management, switching the secrets backend). When the server refuses it for
 * want of one, asks the user for a code, checks it, and retries once.
 */
export async function withFreshCode<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (e) {
    if (!needsFreshCode(e) || !prompter) throw e;
    const code = await prompter();
    if (code === null) throw e;
    await reverify(code);
    return action();
  }
}

/* ---------- The account ---------- */

export interface Account {
  backupCodesLeft: number;
}

export const getAccount = () => get<Account>("/api/account", "account");

/** The devices an account change signed out, when asked to. */
export interface SignedOut {
  revokedDevices: string[];
}

export const changePassphrase = (
  currentPassphrase: string,
  newPassphrase: string,
  signOutOtherDevices: boolean,
) =>
  withFreshCode(() =>
    post<SignedOut>(
      "/api/account/passphrase",
      { currentPassphrase, newPassphrase, signOutOtherDevices },
      "change the passphrase",
    ),
  );

export const startTotpReenroll = () =>
  withFreshCode(() => post<Enrollment>("/api/account/totp/start", {}, "start a new authenticator"));

export const finishTotpReenroll = (
  enrollmentId: string,
  code: string,
  signOutOtherDevices: boolean,
) =>
  withFreshCode(() =>
    post<SignedOut>(
      "/api/account/totp/finish",
      { enrollmentId, code, signOutOtherDevices },
      "confirm the new authenticator",
    ),
  );

export const regenerateBackupCodes = () =>
  withFreshCode(() =>
    post<{ backupCodes: string[] }>("/api/account/backup-codes", {}, "make new backup codes"),
  );

export const signOutOtherDevices = () =>
  withFreshCode(() =>
    post<SignedOut>("/api/account/sign-out-others", {}, "sign out other devices"),
  );

/* ---------- Vault ---------- */

type VaultState = "uninitialized" | "locked" | "unlocked";

/** Opens the server's vault with its own passphrase, not the sign-in one. */
export const unlockVault = (passphrase: string) =>
  post<{ state: VaultState }>("/api/vault/unlock", { passphrase }, "unlock the vault");

/** Opens the server's vault with the recovery key `yarvis-server vault init` printed. */
export const unlockVaultWithRecovery = (recoveryKey: string) =>
  post<{ state: VaultState }>("/api/vault/unlock/recovery", { recoveryKey }, "unlock the vault");

/* ---------- Devices ---------- */

export const getMyDevice = () => get<Device>("/api/devices/me", "this device");

export const listDevices = () => get<Device[]>("/api/devices", "devices");

/**
 * Mints a token for a client that can't sign in itself (a script, a Tauri app
 * pointed at a remote server). The server refuses `admin` and `terminal` here.
 * The response is the only time the token is shown.
 */
export const mintDeviceToken = (name: string, scopes: Scope[]) =>
  withFreshCode(() => post<SignedIn>("/api/devices/tokens", { name, scopes }, "create token"));

export const revokeDevice = (id: string) =>
  withFreshCode(async () => {
    const res = await serverFetch(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
    await ensureOk(res, "revoke device");
  });

/* ---------- Approvals ---------- */

/** A request waiting on a device with the `approve` scope, as `GET /api/approvals` lists it. */
export interface Approval {
  id: string;
  /** What asked, such as `git.sign`. */
  kind: string;
  /** What is being asked, as the server words it. */
  summary: string;
  /** The requester's details, shaped by `kind`. */
  data: Record<string, unknown>;
  /** Milliseconds since the epoch, as is `expiresAt`. */
  createdAt: number;
  /** After this the server denies it. */
  expiresAt: number;
}

/** The approvals still waiting on an answer. */
export const listApprovals = () => get<Approval[]>("/api/approvals", "approvals");

/** Answers an approval. A 409 means another device answered first. */
export async function answerApproval(id: string, approve: boolean): Promise<void> {
  const res = await serverFetch(`/api/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approve }),
  });
  await ensureOk(res, "answer approval");
}
