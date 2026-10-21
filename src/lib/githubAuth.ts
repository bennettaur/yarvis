import { ensureOk, sidecarFetch } from "./api";

// Mirrors the sidecar's `sidecar/src/github/deviceFlow.ts` types.
export interface DeviceFlowStart {
  id: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
}

export type DeviceFlowStatus =
  | { state: "pending"; userCode: string; verificationUri: string; expiresAt: string }
  | { state: "authorized"; login: string | null }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "failed"; error: string };

/** Whether this build has an OAuth App to sign in with. */
export async function githubSignInConfigured(): Promise<boolean> {
  const res = await sidecarFetch("/api/github-auth");
  await ensureOk(res, "GitHub sign-in");
  return ((await res.json()) as { configured: boolean }).configured;
}

export async function startGithubSignIn(): Promise<DeviceFlowStart> {
  const res = await sidecarFetch("/api/github-auth/device", { method: "POST" });
  await ensureOk(res, "GitHub sign-in");
  return res.json();
}

export async function fetchGithubSignInStatus(id: string): Promise<DeviceFlowStatus> {
  const res = await sidecarFetch(`/api/github-auth/device/${encodeURIComponent(id)}`);
  await ensureOk(res, "GitHub sign-in");
  return res.json();
}

export async function cancelGithubSignIn(id: string): Promise<void> {
  const res = await sidecarFetch(`/api/github-auth/device/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await ensureOk(res, "cancel GitHub sign-in");
}
