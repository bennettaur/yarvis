import { tool } from "ai";
import { z } from "zod";
import { MEMORY_KINDS, type MemoryKind } from "../db/schema.ts";
import { fence, newNonce, untrustedWarning } from "../lib/fencing.ts";
import type { MemoryRecord, MemoryService } from "./index.ts";
import { resolveValidity, validityShape } from "./validity.ts";

/**
 * Memory tools for the chat model: store durable facts the user shares, correct
 * them when they change, and recall them later by semantic search.
 */

/**
 * The kinds the model may write. The summary kinds are deliberately absent —
 * those are produced by the consolidation jobs, and letting a turn mint one
 * would put hand-written text where the jobs' own output is read back from.
 */
const WRITABLE_KINDS = [
  "fact",
  "preference",
  "project",
  "decision",
  "agent-feedback",
] as const satisfies readonly MemoryKind[];

/** Every kind is searchable, including the ones only the jobs write. */
const SEARCHABLE_KINDS = MEMORY_KINDS;

/**
 * Recalled content is reference data — from ingested documents, and now from the
 * consolidation jobs, which write summaries of transcripts an agent authored. It
 * must never be followed as instructions, so each hit is fenced in tags carrying
 * a per-response nonce: a static delimiter is one a memory can write for itself,
 * closing the block and addressing this agent directly.
 */

/** The validity fields a reader needs to judge whether to trust a memory. */
function validityFields(record: MemoryRecord) {
  return {
    validity: record.validity,
    validFrom: record.validFrom.toISOString(),
    ...(record.validUntil ? { validUntil: record.validUntil.toISOString() } : {}),
  };
}

export function buildMemoryTools(memory: MemoryService, sessionId: string) {
  return {
    remember: tool({
      description:
        "Store a durable fact, preference, or note the user shares so it can be recalled in future conversations. Pick the kind that fits: 'preference' for how they like to work, 'project' for the state of a project, 'decision' for a choice worth keeping, 'agent-feedback' for guidance about how an agent should behave, 'fact' otherwise. When the claim only holds for a while — an outage, someone out this week, a temporary workaround — pass validFor so a later recall knows to re-check it.",
      inputSchema: z.object({
        content: z.string().describe("The fact to remember, in a self-contained sentence"),
        kind: z.enum(WRITABLE_KINDS).default("fact"),
        ...validityShape,
      }),
      execute: async ({ content, kind, ...request }) => {
        const validity = resolveValidity(request, new Date());
        if (!validity.ok) return { error: validity.error };
        const record = await memory.add(content, {
          kind,
          sourceRef: { type: "chat", sessionId },
          validFrom: validity.validFrom,
          validUntil: validity.validUntil,
        });
        return { id: record.id, kind: record.kind, ...validityFields(record) };
      },
    }),

    recall: tool({
      description:
        "Search the user's stored memories, notes, summaries, and ingested documents for anything relevant to a query. Narrow by kind when you know what you're after — 'session-summary' for past Claude Code sessions, 'day-summary'/'activity-summary' for what they did on a day, 'project' for project state. Each result's validity is 'current', 'upcoming' (not true yet) or 'expired' (past its validUntil, so it may no longer be true).",
      inputSchema: z.object({
        query: z.string(),
        kinds: z
          .array(z.enum(SEARCHABLE_KINDS))
          .optional()
          .describe("Restrict the search to these kinds"),
        limit: z.number().int().min(1).max(20).optional(),
        asOf: z.iso
          .datetime({ offset: true, local: true })
          .optional()
          .describe(
            "Ask what held at a past instant (ISO 8601 datetime) instead of now. Includes memories corrected since",
          ),
      }),
      execute: async ({ query, kinds, limit, asOf }) => {
        const results = await memory.search(query, limit ?? 5, {
          kinds,
          asOf: asOf ? new Date(asOf) : undefined,
        });
        const nonce = newNonce();
        return {
          warning: untrustedWarning(nonce),
          results: results.map((r) => ({
            id: r.id,
            kind: r.kind,
            score: r.score,
            createdAt: r.createdAt.toISOString(),
            ...validityFields(r),
            content: fence(r.content, nonce),
          })),
        };
      },
    }),

    list_memories: tool({
      description:
        "Browse stored memories newest-first, optionally by kind. Use this to check what you already know before writing a near-duplicate, or to enumerate recent summaries; use recall to find something by meaning.",
      inputSchema: z.object({
        kinds: z.array(z.enum(SEARCHABLE_KINDS)).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ kinds, limit }) => {
        const records = await memory.list({ kinds, limit: limit ?? 20 });
        const nonce = newNonce();
        return {
          warning: untrustedWarning(nonce),
          memories: records.map((r) => ({
            id: r.id,
            kind: r.kind,
            createdAt: r.createdAt.toISOString(),
            ...validityFields(r),
            content: fence(r.content, nonce),
          })),
        };
      },
    }),

    correct_memory: tool({
      description:
        "Replace what a stored memory says when the user tells you it changed — a project moving on, a preference reversing. The old memory is kept but drops out of recall, so use this rather than remembering a second, contradicting fact.",
      inputSchema: z.object({
        id: z.string().describe("Id of the memory to correct (from recall or list_memories)"),
        content: z.string().describe("What is true now, as a self-contained sentence"),
        ...validityShape,
      }),
      execute: async ({ id, content, ...request }) => {
        const validity = resolveValidity(request, new Date());
        if (!validity.ok) return { error: validity.error };
        const replacement = await memory.supersede(id, content, {
          sourceRef: { type: "chat", sessionId },
          validFrom: validity.validFrom,
          validUntil: validity.validUntil,
        });
        return replacement
          ? { id: replacement.id, supersededId: id, ...validityFields(replacement) }
          : { error: "no memory with that id" };
      },
    }),

    confirm_memory: tool({
      description:
        "Record that you checked a memory and it still holds — typically one recall marked expired. It ranks as fresh again and, if it had an expiry, gets a new one: the same window as before unless you pass validFor or validUntil. If the check showed it no longer holds, use correct_memory instead.",
      inputSchema: z.object({
        id: z.string().describe("Id of the memory you checked (from recall or list_memories)"),
        validFor: validityShape.validFor,
        validUntil: validityShape.validUntil,
      }),
      execute: async ({ id, validFor, validUntil }) => {
        const validity = resolveValidity({ validFor, validUntil }, new Date());
        if (!validity.ok) return { error: validity.error };
        const confirmed = await memory.confirm(id, { validUntil: validity.validUntil });
        return confirmed
          ? { id: confirmed.id, confirmCount: confirmed.confirmCount, ...validityFields(confirmed) }
          : { error: "no current memory with that id" };
      },
    }),

    forget_memory: tool({
      description:
        "Permanently delete a memory. Only when the user asks for it to be gone; prefer correct_memory when the fact merely changed, since that keeps the trail.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const deleted = await memory.delete(id);
        return deleted ? { id, deleted: true } : { error: "no memory with that id" };
      },
    }),

    take_note: tool({
      description:
        "Capture a freeform note the user wants to jot down. Notes are kept and feed into daily/weekly recaps.",
      inputSchema: z.object({
        content: z.string().describe("The note text, verbatim or lightly cleaned up"),
      }),
      execute: async ({ content }) => {
        const record = await memory.add(content, {
          kind: "note",
          sourceRef: { type: "chat", sessionId },
        });
        return { id: record.id };
      },
    }),
  };
}
