import { ensureOk, sidecarFetch } from "./api";

export interface DeviceFlowStart {
  id: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
}

export type DeviceFlowStatus =
  | { state: "pending"; userCode: string; verificationUri: string; expiresAt: string }
  | { state: "authorized" }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "failed"; error: string };

export async function startGithubSignIn(): Promise<DeviceFlowStart> {
  const res = await sidecarFetch("/api/github-auth/device", { method: "POST" });
  await ensureOk(res, "GitHub sign-in");
  return res.json();
}

export async function githubSignInStatus(id: string): Promise<DeviceFlowStatus> {
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
