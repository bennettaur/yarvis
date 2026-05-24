import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseHistory,
  parsePlanTitle,
  parseSessionSummary,
  parseTranscript,
  type HistoryEntry,
  type SessionSummary,
  type TranscriptEntry,
} from "./parse.ts";

function ccHome(): string {
  return process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
}

const projectsDir = () => join(ccHome(), "projects");
const plansDir = () => join(ccHome(), "plans");

/** Rejects names that could escape the intended directory. */
function safeName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes("..");
}

function within(parent: string, child: string): boolean {
  return resolve(child).startsWith(resolve(parent));
}

export interface ProjectInfo {
  dir: string;
  path: string | null;
  sessionCount: number;
  updatedAt: string | null;
}

export interface PlanInfo {
  name: string;
  title: string | null;
  updatedAt: string;
  size: number;
}

export async function listProjects(): Promise<ProjectInfo[]> {
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir());
  } catch {
    return [];
  }

  const projects: ProjectInfo[] = [];
  for (const dir of dirs) {
    const full = join(projectsDir(), dir);
    let files: string[];
    try {
      files = (await readdir(full)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    let newest = "";
    let newestMtime = 0;
    for (const f of files) {
      const s = await stat(join(full, f));
      if (s.mtimeMs > newestMtime) {
        newestMtime = s.mtimeMs;
        newest = f;
      }
    }

    // Prefer the real cwd recorded in the newest session over decoding the dir.
    let path = dir.replace(/-/g, "/");
    try {
      const summary = parseSessionSummary(await readFile(join(full, newest), "utf8"));
      if (summary.cwd) path = summary.cwd;
    } catch {
      // fall back to the decoded directory name
    }

    projects.push({
      dir,
      path,
      sessionCount: files.length,
      updatedAt: new Date(newestMtime).toISOString(),
    });
  }

  projects.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return projects;
}

export async function listSessions(projectDir: string): Promise<SessionSummary[]> {
  if (!safeName(projectDir)) throw new Error("invalid project");
  const full = join(projectsDir(), projectDir);
  if (!within(projectsDir(), full)) throw new Error("invalid project");

  let files: string[];
  try {
    files = (await readdir(full)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const sessions: SessionSummary[] = [];
  for (const f of files) {
    try {
      const summary = parseSessionSummary(await readFile(join(full, f), "utf8"));
      if (!summary.id) summary.id = f.replace(/\.jsonl$/, "");
      sessions.push(summary);
    } catch {
      // skip unreadable session files
    }
  }

  sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return sessions;
}

export async function getTranscript(
  projectDir: string,
  sessionId: string,
): Promise<TranscriptEntry[]> {
  if (!safeName(projectDir) || !safeName(sessionId)) {
    throw new Error("invalid identifiers");
  }
  const file = join(projectsDir(), projectDir, `${sessionId}.jsonl`);
  if (!within(projectsDir(), file)) throw new Error("invalid path");
  return parseTranscript(await readFile(file, "utf8"));
}

export async function listPlans(): Promise<PlanInfo[]> {
  let files: string[];
  try {
    files = (await readdir(plansDir())).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const plans: PlanInfo[] = [];
  for (const f of files) {
    const s = await stat(join(plansDir(), f));
    const content = await readFile(join(plansDir(), f), "utf8");
    plans.push({
      name: f,
      title: parsePlanTitle(content),
      updatedAt: new Date(s.mtimeMs).toISOString(),
      size: s.size,
    });
  }

  plans.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return plans;
}

export async function getPlan(name: string): Promise<string> {
  if (!safeName(name) || !name.endsWith(".md")) throw new Error("invalid plan");
  const file = join(plansDir(), name);
  if (!within(plansDir(), file)) throw new Error("invalid plan");
  return readFile(file, "utf8");
}

export async function recentHistory(
  limit = 50,
  project?: string,
): Promise<HistoryEntry[]> {
  let content: string;
  try {
    content = await readFile(join(ccHome(), "history.jsonl"), "utf8");
  } catch {
    return [];
  }
  let entries = parseHistory(content, project ? 100_000 : limit);
  if (project) {
    entries = entries.filter((e) => e.project === project).slice(0, limit);
  }
  return entries;
}
