import { sidecarFetch } from "./api";

/**
 * Client for the assistant's artifacts: documents it wrote, like a morning
 * brief or its own scratchpad. The agent writes them through its tools; the UI
 * only reads them and deletes the ones the user doesn't want kept.
 */

export type ArtifactFormat = "markdown";

/** Who created it: a chat with the user, a heads-down pass, or a specialist (which runs jobs). */
export type ArtifactWriter = "chat" | "heads-down" | "specialist";

export interface ArtifactSummary {
  id: string;
  title: string;
  format: ArtifactFormat;
  createdBy: ArtifactWriter;
  /** Something other than the user may have shaped its text. */
  untrusted: boolean;
  /** Content length in characters. */
  length: number;
  createdAt: string;
  updatedAt: string;
}

export interface Artifact extends Omit<ArtifactSummary, "length"> {
  content: string;
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await sidecarFetch(
    path,
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
}

export const listArtifacts = () => request<ArtifactSummary[]>("/api/artifacts");

export const getArtifact = (id: string) => request<Artifact>(`/api/artifacts/${id}`);

export const deleteArtifact = (id: string) =>
  request<{ deleted: boolean }>(`/api/artifacts/${id}`, "DELETE");

export const deleteArtifacts = (ids: string[]) =>
  request<{ deleted: number }>("/api/artifacts/delete", "POST", { ids });
