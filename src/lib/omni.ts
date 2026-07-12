import type { Spec } from "@json-render/core";
import { ensureOk, sidecarFetch, streamSSE } from "./api";
import type { ProviderId } from "./chat";

/** A conversational turn sent to the Omni generator. */
export interface OmniMessage {
  role: "user" | "assistant";
  content: string;
}

export interface OmniRequest {
  /** System prompt describing the component catalog (from `catalog.prompt()`). */
  system: string;
  messages: OmniMessage[];
  provider: ProviderId;
  model: string;
}

export interface OmniEvent {
  type: "delta" | "done" | "error";
  text?: string;
  message?: string;
}

/**
 * Streams the model's output for a UI-generation request: conversational text
 * interleaved with json-render JSONL spec patches. The caller splits the two
 * (e.g. with `createMixedStreamParser`).
 */
export async function* streamOmni(req: OmniRequest): AsyncGenerator<OmniEvent> {
  for await (const data of streamSSE("/api/omni/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  })) {
    yield JSON.parse(data) as OmniEvent;
  }
}

/** A saved layout without its (potentially large) spec. */
export interface OmniLayoutSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface OmniLayoutDetail extends OmniLayoutSummary {
  spec: Spec;
}

export async function listLayouts(): Promise<OmniLayoutSummary[]> {
  const res = await sidecarFetch("/api/omni/layouts");
  await ensureOk(res, "list layouts");
  return res.json();
}

/** Saves the spec under a name, overwriting any existing layout with that name. */
export async function saveLayout(name: string, spec: Spec): Promise<OmniLayoutSummary> {
  const res = await sidecarFetch("/api/omni/layouts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, spec }),
  });
  await ensureOk(res, "save layout");
  return res.json();
}

export async function getLayout(id: string): Promise<OmniLayoutDetail> {
  const res = await sidecarFetch(`/api/omni/layouts/${id}`);
  await ensureOk(res, "get layout");
  return res.json();
}

export async function deleteLayout(id: string): Promise<void> {
  const res = await sidecarFetch(`/api/omni/layouts/${id}`, { method: "DELETE" });
  await ensureOk(res, "delete layout");
}
