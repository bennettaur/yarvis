import { sidecarFetch } from "./api";

export interface CcProject {
  dir: string;
  path: string | null;
  sessionCount: number;
  updatedAt: string | null;
}

export interface CcSession {
  id: string | null;
  title: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  messageCount: number;
  cwd: string | null;
  gitBranch: string | null;
  startedAt: string | null;
  updatedAt: string | null;
}

export interface CcTranscriptEntry {
  role: string;
  text: string;
  timestamp: string | null;
}

export interface CcPlan {
  name: string;
  title: string | null;
  updatedAt: string;
  size: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await sidecarFetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

export const listProjects = () => get<CcProject[]>("/api/cc/projects");

export const listSessions = (dir: string) =>
  get<CcSession[]>(`/api/cc/projects/${encodeURIComponent(dir)}/sessions`);

export const getTranscript = (dir: string, id: string) =>
  get<CcTranscriptEntry[]>(
    `/api/cc/projects/${encodeURIComponent(dir)}/sessions/${encodeURIComponent(id)}`,
  );

export const listPlans = () => get<CcPlan[]>("/api/cc/plans");

export const getPlan = (name: string) =>
  get<{ name: string; content: string }>(`/api/cc/plans/${encodeURIComponent(name)}`);
