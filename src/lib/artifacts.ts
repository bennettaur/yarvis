import { SidecarError, sidecarFetch, streamSSE } from "./api";

/**
 * Client for the assistant's artifacts: documents it wrote, like a morning
 * brief or its own scratchpad. The agent writes them through its tools; the UI
 * only reads them and deletes the ones the user doesn't want kept.
 */

/** An `excalidraw` artifact's content is a JSON `Diagram` (`./artifactDiagram`). */
export type ArtifactFormat = "markdown" | "excalidraw";

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
  if (!res.ok) throw new SidecarError(`${method} ${path} → ${res.status}`, res.status);
  return res.json();
}

export const listArtifacts = () => request<ArtifactSummary[]>("/api/artifacts");

export const getArtifact = (id: string) => request<Artifact>(`/api/artifacts/${id}`);

export const deleteArtifact = (id: string) =>
  request<{ deleted: boolean }>(`/api/artifacts/${id}`, "DELETE");

export const deleteArtifacts = (ids: string[]) =>
  request<{ deleted: number }>("/api/artifacts/delete", "POST", { ids });

const RECONNECT_MS = 2_000;

/**
 * Follows one artifact until the returned function is called, reconnecting
 * when the stream drops. `onChange` fires on each write (and once on every
 * reconnect, since a write may have landed while it was down), so the caller
 * re-reads the artifact; `onDeleted` fires once and ends the subscription.
 * `onChange` also fires once each time the stream connects, since a write may
 * have landed before it did.
 */
export function subscribeArtifact(
  id: string,
  { onChange, onDeleted }: { onChange: () => void; onDeleted: () => void },
  reconnectMs = RECONNECT_MS,
): () => void {
  const controller = new AbortController();
  const signal = controller.signal;

  void (async () => {
    // True for the first connection too: a write can land between the caller's
    // first read and the stream subscribing, and nothing else would show it.
    let reconnecting = true;
    while (!signal.aborted) {
      try {
        for await (const data of streamSSE(`/api/artifacts/${id}/stream`, { signal })) {
          let frame: { type?: string };
          try {
            frame = JSON.parse(data);
          } catch (e) {
            console.warn("[artifacts] dropped unparseable stream frame:", e);
            continue;
          }
          if (frame.type === "deleted") {
            onDeleted();
            return;
          }
          if (frame.type === "updated" || reconnecting) onChange();
          reconnecting = false;
        }
      } catch (e) {
        // The sidecar refuses a stream for an artifact that is gone, which is how
        // a delete sent while the stream was down still reaches the pane.
        if (e instanceof SidecarError && e.status === 404) {
          onDeleted();
          return;
        }
        if (!signal.aborted) console.warn("[artifacts] stream dropped, reconnecting:", e);
      }
      if (signal.aborted) break;
      reconnecting = true;
      await new Promise((resolve) => setTimeout(resolve, reconnectMs));
    }
  })();

  return () => controller.abort();
}
