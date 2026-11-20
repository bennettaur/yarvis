import { ensureOk, SidecarError } from "./api";
import { saveDeviceToken, serverFetch } from "./server";

/**
 * Client for the server's sign-in, devices and approvals routes
 * (`docs/client-server.md`). A device is one signed-in client or one token
 * minted for a script; each carries its own scopes and can be revoked alone.
 */

export type Scope = "read" | "chat" | "approve" | "admin";
export const ALL_SCOPES: readonly Scope[] = ["read", "chat", "approve", "admin"];

export interface AuthStatus {
  setupRequired: boolean;
  rpId: string;
  vault: "absent" | "locked" | "unlocked";
}

export interface Device {
  id: string;
  name: string;
  kind?: "passkey" | "token";
  scopes: Scope[];
  createdAt?: number | string | null;
  lastSeenAt?: number | string | null;
  revokedAt?: number | string | null;
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

// --- WebAuthn: the server sends binary fields as base64url; the browser API wants ArrayBuffers.

export function base64urlToBuffer(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return bytes.buffer;
}

export function bufferToBase64url(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    buf instanceof ArrayBuffer
      ? new Uint8Array(buf)
      : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface JsonCredentialDescriptor {
  id: string;
  type: string;
  transports?: string[];
}

interface JsonCreationOptions {
  publicKey: Omit<
    PublicKeyCredentialCreationOptions,
    "challenge" | "user" | "excludeCredentials"
  > & {
    challenge: string;
    user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string };
    excludeCredentials?: JsonCredentialDescriptor[];
  };
}

interface JsonRequestOptions {
  publicKey: Omit<PublicKeyCredentialRequestOptions, "challenge" | "allowCredentials"> & {
    challenge: string;
    allowCredentials?: JsonCredentialDescriptor[];
  };
}

/**
 * What a ceremony's `start` route answers: the options, either bare or beside
 * a ceremony id the matching `finish` route needs back.
 */
type Started<O> = O | { options: O; ceremonyId?: string };

function unwrap<O extends { publicKey: unknown }>(
  started: Started<O>,
): { options: O; ceremonyId?: string } {
  return "options" in started ? started : { options: started };
}

const descriptor = (c: JsonCredentialDescriptor): PublicKeyCredentialDescriptor => ({
  ...c,
  type: "public-key",
  id: base64urlToBuffer(c.id),
  transports: c.transports as AuthenticatorTransport[] | undefined,
});

export function toCreationOptions(json: JsonCreationOptions): CredentialCreationOptions {
  const pk = json.publicKey;
  return {
    publicKey: {
      ...pk,
      challenge: base64urlToBuffer(pk.challenge),
      user: { ...pk.user, id: base64urlToBuffer(pk.user.id) },
      excludeCredentials: pk.excludeCredentials?.map(descriptor),
    },
  };
}

export function toRequestOptions(json: JsonRequestOptions): CredentialRequestOptions {
  const pk = json.publicKey;
  return {
    publicKey: {
      ...pk,
      challenge: base64urlToBuffer(pk.challenge),
      allowCredentials: pk.allowCredentials?.map(descriptor),
    },
  };
}

/** A new passkey as the JSON webauthn-rs reads. */
export function registrationJson(cred: PublicKeyCredential): unknown {
  const response = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: bufferToBase64url(cred.rawId),
    type: cred.type,
    response: {
      attestationObject: bufferToBase64url(response.attestationObject),
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      transports: response.getTransports?.() ?? [],
    },
  };
}

/** A passkey assertion as the JSON webauthn-rs reads. */
export function assertionJson(cred: PublicKeyCredential): unknown {
  const response = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bufferToBase64url(cred.rawId),
    type: cred.type,
    response: {
      authenticatorData: bufferToBase64url(response.authenticatorData),
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      signature: bufferToBase64url(response.signature),
      userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : null,
    },
  };
}

function noCredential(): Error {
  return new Error("no passkey was chosen");
}

async function createPasskey(json: JsonCreationOptions): Promise<unknown> {
  const cred = (await navigator.credentials.create(
    toCreationOptions(json),
  )) as PublicKeyCredential | null;
  if (!cred) throw noCredential();
  return registrationJson(cred);
}

async function assertPasskey(json: JsonRequestOptions): Promise<unknown> {
  const cred = (await navigator.credentials.get(
    toRequestOptions(json),
  )) as PublicKeyCredential | null;
  if (!cred) throw noCredential();
  return assertionJson(cred);
}

/** First run: registers a passkey with the setup code the server printed, and signs in. */
export async function setUpWithCode(code: string, deviceName: string): Promise<SignedIn> {
  const started = unwrap(
    await post<Started<JsonCreationOptions>>(
      "/api/auth/setup/start",
      { code, deviceName },
      "start setup",
    ),
  );
  const credential = await createPasskey(started.options);
  const signedIn = await post<SignedIn>(
    "/api/auth/setup/finish",
    { credential, ceremonyId: started.ceremonyId, deviceName },
    "finish setup",
  );
  saveDeviceToken(signedIn.token);
  return signedIn;
}

/** Signs in with a passkey; the server makes this browser a new device. */
export async function signInWithPasskey(deviceName: string): Promise<SignedIn> {
  const started = unwrap(
    await post<Started<JsonRequestOptions>>("/api/auth/login/start", {}, "start sign-in"),
  );
  const credential = await assertPasskey(started.options);
  const signedIn = await post<SignedIn>(
    "/api/auth/login/finish",
    { credential, ceremonyId: started.ceremonyId, deviceName },
    "sign in",
  );
  saveDeviceToken(signedIn.token);
  return signedIn;
}

/** Checks the passkey again, which admin actions need within the last few minutes. */
export async function reverify(): Promise<void> {
  const started = unwrap(
    await post<Started<JsonRequestOptions>>("/api/auth/reverify/start", {}, "start check"),
  );
  const credential = await assertPasskey(started.options);
  await post<unknown>(
    "/api/auth/reverify/finish",
    { credential, ceremonyId: started.ceremonyId },
    "passkey check",
  );
}

// --- Devices

export const getMyDevice = () => get<Device>("/api/devices/me", "this device");

export const listDevices = () => get<Device[]>("/api/devices", "devices");

/**
 * Runs an admin action, checking the passkey once and retrying when the server
 * refuses it (403) for want of a recent check.
 */
async function withFreshPasskey<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (e) {
    if (!(e instanceof SidecarError) || e.status !== 403) throw e;
    await reverify();
    return action();
  }
}

/** Mints a token for a client that can't use a passkey. The token is shown once and never again. */
export const mintDeviceToken = (name: string, scopes: Scope[]) =>
  withFreshPasskey(() => post<SignedIn>("/api/devices/tokens", { name, scopes }, "create token"));

export const revokeDevice = (id: string) =>
  withFreshPasskey(async () => {
    const res = await serverFetch(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
    await ensureOk(res, "revoke device");
  });

// --- Approvals

export interface Approval {
  id: string;
  kind: string;
  /** What is being asked, as the server words it. */
  summary?: string;
  detail?: string;
  createdAt?: number | string;
  deviceId?: string | null;
  status?: "pending" | "approved" | "denied" | "expired";
}

export async function listApprovals(): Promise<Approval[]> {
  const body = await get<unknown>("/api/approvals", "approvals");
  if (Array.isArray(body)) return body as Approval[];
  const items = (body as { approvals?: unknown })?.approvals;
  return Array.isArray(items) ? (items as Approval[]) : [];
}

/** Answers an approval. A 409 means another device answered first. */
export async function answerApproval(id: string, approve: boolean): Promise<void> {
  const res = await serverFetch(`/api/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approve }),
  });
  await ensureOk(res, "answer approval");
}
