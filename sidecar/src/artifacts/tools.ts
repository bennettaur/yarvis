import { tool } from "ai";
import { z } from "zod";
import type { UntrustedReads } from "../chat/destructiveTools.ts";
import type { Db } from "../db/client.ts";
import { fence, newNonce, untrustedWarning } from "../lib/fencing.ts";
import {
  ARTIFACT_LIST_LIMIT,
  ArtifactTooLargeError,
  type ArtifactWriter,
  createArtifact,
  deleteArtifact,
  getArtifact,
  isWrittenUnattended,
  listArtifacts,
  MAX_ARTIFACT_CHARS,
  updateArtifact,
} from "./service.ts";

/**
 * The agent's artifact tools. Not registered on the MCP endpoint, for the same
 * reason as the todo tools: these are the in-app assistant's own documents.
 */

const uuid = z.string().uuid();
const title = z.string().trim().min(1).max(200);
const content = z.string().max(MAX_ARTIFACT_CHARS);

const TOO_LARGE = `That would make the artifact longer than ${MAX_ARTIFACT_CHARS} characters. Summarize or trim it, or start a new artifact.`;

const NOT_YOURS =
  "This artifact came from a chat with the user, so you can only append to it. Start a new artifact to rewrite or rename it.";

/**
 * `writer` is who is calling: what it creates is marked as its own, and a heads-
 * down pass or specialist run can only append to an artifact a chat turn wrote,
 * since a rewrite would wipe the user's document with no history to restore.
 * `reads` records a read of an artifact one of those wrote.
 */
export function buildArtifactTools(
  db: Db,
  { writer = "chat", reads }: { writer?: ArtifactWriter; reads?: UntrustedReads } = {},
) {
  return {
    create_artifact: tool({
      description:
        "Write a document you or the user will come back to: a morning brief, a report, a plan, or a scratchpad of your own notes. Content is markdown. Returns the id to read or update it later.",
      inputSchema: z.object({
        title: title.describe("Short and specific, e.g. 'Morning brief 2026-10-30'"),
        content: content.optional().describe("Markdown. Leave out to start an empty scratchpad"),
      }),
      execute: async ({ title: t, content: c }) => {
        try {
          const artifact = await createArtifact(db, { title: t, content: c, writer });
          return { id: artifact.id, title: artifact.title, length: artifact.content.length };
        } catch (err) {
          if (err instanceof ArtifactTooLargeError) return { error: TOO_LARGE };
          throw err;
        }
      },
    }),

    list_artifacts: tool({
      description: `Your artifacts, most recently changed first, without their content (the latest ${ARTIFACT_LIST_LIMIT}; use titleContains to find an older one). Check here before creating one, so you add to an existing scratchpad rather than starting a second.`,
      inputSchema: z.object({
        titleContains: z.string().max(200).optional(),
      }),
      execute: async ({ titleContains }) => {
        const nonce = newNonce();
        const rows = await listArtifacts(db, { titleContains });
        return {
          warning: untrustedWarning(nonce),
          artifacts: rows.map((a) => ({
            id: a.id,
            title: fence(a.title, nonce),
            format: a.format,
            length: a.length,
            updatedAt: a.updatedAt.toISOString(),
          })),
        };
      },
    }),

    get_artifact: tool({
      description: "Read one of your artifacts in full.",
      inputSchema: z.object({ id: uuid }),
      execute: async ({ id }) => {
        const artifact = await getArtifact(db, id);
        if (!artifact) return { error: "no artifact with that id" };
        if (reads && isWrittenUnattended(artifact)) reads.hasReadUnattendedArtifact = true;
        // Fenced because an artifact can quote what a pass read (a ticket, a
        // Slack message), and that text must not read as an instruction later.
        const nonce = newNonce();
        return {
          warning: untrustedWarning(nonce),
          id: artifact.id,
          title: fence(artifact.title, nonce),
          format: artifact.format,
          content: fence(artifact.content, nonce),
          updatedAt: artifact.updatedAt.toISOString(),
        };
      },
    }),

    update_artifact: tool({
      description: `Change one of your artifacts. Use append to add to the end (a new note, today's entry) without resending what is there; use content to rewrite it whole. Read it with get_artifact first if you are rewriting.${
        writer === "chat"
          ? ""
          : " You can only append to an artifact written in a chat with the user, not rewrite or rename it."
      }`,
      inputSchema: z.object({
        id: uuid,
        title: title.optional(),
        content: content.optional().describe("Replaces the whole content"),
        append: content
          .optional()
          .describe("Added to the end as-is; start it with a newline to begin a new line"),
      }),
      execute: async ({ id, ...patch }) => {
        if (writer !== "chat" && (patch.content !== undefined || patch.title !== undefined)) {
          const current = await getArtifact(db, id);
          if (!current) return { error: "no artifact with that id" };
          if (current.createdBy === "chat") return { error: NOT_YOURS };
        }
        try {
          const artifact = await updateArtifact(db, id, { ...patch, writer });
          return artifact
            ? { id: artifact.id, length: artifact.content.length }
            : { error: "no artifact with that id" };
        } catch (err) {
          if (err instanceof ArtifactTooLargeError) return { error: TOO_LARGE };
          throw err;
        }
      },
    }),

    delete_artifact: tool({
      description: "Permanently delete one of your artifacts.",
      inputSchema: z.object({ id: uuid }),
      execute: async ({ id }) => {
        const deleted = await deleteArtifact(db, id);
        return deleted ? { id, deleted: true } : { error: "no artifact with that id" };
      },
    }),
  };
}
