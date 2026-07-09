import { sidecarFetch } from "./api";

export interface AppSettings {
  claudeCommand: string;
}

export async function getSettings(): Promise<AppSettings> {
  const res = await sidecarFetch("/api/settings");
  if (!res.ok) throw new Error("failed to get settings");
  return res.json();
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
  const res = await sidecarFetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("failed to update settings");
}
