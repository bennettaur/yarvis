import { tool } from "ai";
import { z } from "zod";
import { hasReadUntrusted, type UntrustedReads } from "../chat/destructiveTools.ts";
import type { Db } from "../db/client.ts";
import { fence, newNonce, untrustedWarning } from "../lib/fencing.ts";
import {
  DIAGRAM_COLORS,
  DiagramError,
  diagramChangesSchema,
  diagramSchema,
  MAX_DIAGRAM_EDGES,
  MAX_DIAGRAM_NODES,
} from "./diagram.ts";
import {
  ARTIFACT_LIST_LIMIT,
  ArtifactAppendOnlyError,
  ArtifactFormatError,
  ArtifactRunLimitError,
  ArtifactTooLargeError,
  type ArtifactWriter,
  CHAT_ARTIFACT_RUN_LIMIT,
  createArtifact,
  createDiagram,
  deleteArtifact,
  getArtifact,
  listArtifacts,
  MAX_ARTIFACT_CHARS,
  NotADiagramError,
  updateArtifact,
  updateDiagram,
} from "./service.ts";

/**
 * The agent's artifact tools. Not registered on the MCP endpoint, for the same
 * reason as the todo tools: these are the in-app assistant's own documents.
 */

const uuid = z.string().uuid();
const title = z.string().trim().min(1).max(200);
const content = z.string().max(MAX_ARTIFACT_CHARS);

const TOO_LARGE = `That would make the artifact longer than ${MAX_ARTIFACT_CHARS} characters. Summarize or trim it, or start a new artifact.`;

const APPEND_ONLY =
  "This artifact came from a chat with the user, so you can only append to it. Start a new artifact to rewrite or rename it.";

const RUN_LIMIT = `This artifact came from a chat with the user, and you can't grow it past ${CHAT_ARTIFACT_RUN_LIMIT} characters, so the user has room to add to it. Start a new artifact for the rest.`;

const CHAT_ARTIFACT_KEPT =
  "This artifact came from a chat with the user, so only the user can delete it.";

const DIAGRAM_APPEND_ONLY =
  "This diagram came from a chat with the user, so you can only add new nodes and edges to it. Start a new diagram to change or remove what is there.";

const NOT_TEXT =
  "That artifact is a diagram. Change it with update_diagram; update_artifact can only rename it.";

/**
 * The address the chat renders as a link that opens the artifact beside the
 * conversation (`src/lib/artifactLink.ts`).
 */
export function artifactLink(id: string): string {
  return `yarvis://artifact/${id}`;
}

const LINK_HINT =
  "Returns a link: put it in your reply as a markdown link, e.g. [Morning brief](yarvis://artifact/<id>), so the user can open it beside the chat.";

/**
 * `writer` is who is calling; a heads-down pass or specialist run can only
 * append to an artifact a chat turn created. `reads` is the turn's record of
 * untrusted reads: reading an untrusted artifact adds to it, and anything
 * written after an untrusted read is marked untrusted too.
 */
export function buildArtifactTools(
  db: Db,
  { writer = "chat", reads }: { writer?: ArtifactWriter; reads?: UntrustedReads } = {},
) {
  // Text written after an untrusted read may have come from what was read.
  const tainted = () => (reads ? hasReadUntrusted(reads) : false);
  const appendOnlyNote =
    writer === "chat"
      ? ""
      : ` You can only append to an artifact that came from a chat with the user, up to ${CHAT_ARTIFACT_RUN_LIMIT} characters, not rewrite, rename or delete it.`;

  return {
    create_artifact: tool({
      description: `Write a document you or the user will come back to: a morning brief, a report, a plan, or a scratchpad of your own notes. Content is markdown. Returns the id to read or update it later. ${LINK_HINT}`,
      inputSchema: z.object({
        title: title.describe("Short and specific, e.g. 'Morning brief 2026-10-30'"),
        content: content.optional().describe("Markdown. Leave out to start an empty scratchpad"),
      }),
      execute: async ({ title: t, content: c }) => {
        try {
          const artifact = await createArtifact(db, {
            title: t,
            content: c,
            writer,
            untrusted: tainted(),
          });
          return {
            id: artifact.id,
            title: artifact.title,
            length: artifact.content.length,
            link: artifactLink(artifact.id),
          };
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
        // A pass can write a title as easily as content, so seeing one counts as reading it.
        if (reads && rows.some((a) => a.untrusted)) reads.hasReadUntrustedArtifact = true;
        return {
          warning: untrustedWarning(nonce),
          artifacts: rows.map((a) => ({
            id: a.id,
            title: fence(a.title, nonce),
            format: a.format,
            createdBy: a.createdBy,
            untrusted: a.untrusted,
            length: a.length,
            updatedAt: a.updatedAt.toISOString(),
          })),
        };
      },
    }),

    get_artifact: tool({
      description:
        "Read one of your artifacts in full. A diagram's content is its JSON nodes and edges; read it before update_diagram so you use the ids already there.",
      inputSchema: z.object({ id: uuid }),
      execute: async ({ id }) => {
        const artifact = await getArtifact(db, id);
        if (!artifact) return { error: "no artifact with that id" };
        if (reads && artifact.untrusted) reads.hasReadUntrustedArtifact = true;
        // Fenced because an artifact can quote what a pass read (a ticket, a
        // Slack message), and that text must not read as an instruction later.
        const nonce = newNonce();
        return {
          warning: untrustedWarning(nonce),
          id: artifact.id,
          title: fence(artifact.title, nonce),
          format: artifact.format,
          createdBy: artifact.createdBy,
          untrusted: artifact.untrusted,
          content: fence(artifact.content, nonce),
          updatedAt: artifact.updatedAt.toISOString(),
        };
      },
    }),

    update_artifact: tool({
      description: `Change one of your artifacts. Use append to add to the end (a new note, today's entry) without resending what is there; use content to rewrite it whole. Read it with get_artifact first if you are rewriting.${appendOnlyNote}`,
      inputSchema: z.object({
        id: uuid,
        title: title.optional(),
        content: content.optional().describe("Replaces the whole content"),
        append: content
          .optional()
          .describe("Added to the end as-is; start it with a newline to begin a new line"),
      }),
      execute: async ({ id, ...patch }) => {
        try {
          const artifact = await updateArtifact(db, id, { ...patch, writer, untrusted: tainted() });
          return artifact
            ? { id: artifact.id, length: artifact.content.length, link: artifactLink(artifact.id) }
            : { error: "no artifact with that id" };
        } catch (err) {
          if (err instanceof ArtifactFormatError) return { error: NOT_TEXT };
          if (err instanceof ArtifactTooLargeError) return { error: TOO_LARGE };
          if (err instanceof ArtifactAppendOnlyError) return { error: APPEND_ONLY };
          if (err instanceof ArtifactRunLimitError) return { error: RUN_LIMIT };
          throw err;
        }
      },
    }),

    create_diagram: tool({
      description: `Draw a diagram the user can watch and come back to: an architecture sketch, a flow, a plan of how pieces connect. It is drawn in Excalidraw. Nodes are boxes (or ellipses, diamonds, or free text); edges are arrows between two nodes. Pick short, meaningful ids (e.g. "api", "db", "api-db") so you can change one element later with update_diagram. Leave out x/y and the nodes are laid out left to right along the edges; give x/y (pixels, y grows downward) on every node to place them yourself. Up to ${MAX_DIAGRAM_NODES} nodes and ${MAX_DIAGRAM_EDGES} edges. ${LINK_HINT}`,
      inputSchema: z.object({
        title: title.describe("Short and specific, e.g. 'Checkout service architecture'"),
        nodes: diagramSchema.shape.nodes.describe(
          `Each needs an id. label is the text shown; shape defaults to rectangle; color is one of ${DIAGRAM_COLORS.join(", ")}`,
        ),
        edges: diagramSchema.shape.edges
          .default([])
          .describe("Arrows from one node id to another, each with its own id"),
      }),
      execute: async ({ title: t, nodes, edges }) => {
        try {
          const artifact = await createDiagram(db, {
            title: t,
            diagram: { nodes, edges },
            writer,
            untrusted: tainted(),
          });
          return { id: artifact.id, title: artifact.title, link: artifactLink(artifact.id) };
        } catch (err) {
          if (err instanceof DiagramError) return { error: err.message };
          if (err instanceof ArtifactTooLargeError) return { error: TOO_LARGE };
          throw err;
        }
      },
    }),

    update_diagram: tool({
      description: `Change one of your diagrams in place; the user sees each change as it lands if they have it open. upsertNodes and upsertEdges add an element, or change the fields you give on the one with that id and keep the rest. A new edge needs from and to. removeNodes also removes the edges attached to those nodes. Removals run first, then node upserts, then edge upserts. Use get_artifact to see the current ids.${
        writer === "chat"
          ? ""
          : " You can only add new nodes and edges to a diagram that came from a chat with the user."
      }`,
      inputSchema: diagramChangesSchema.extend({ id: uuid, title: title.optional() }),
      execute: async ({ id, title: t, ...changes }) => {
        try {
          const artifact = await updateDiagram(db, id, {
            title: t,
            changes,
            writer,
            untrusted: tainted(),
          });
          if (!artifact) return { error: "no artifact with that id" };
          const diagram = JSON.parse(artifact.content) as { nodes: unknown[]; edges: unknown[] };
          return {
            id: artifact.id,
            nodes: diagram.nodes.length,
            edges: diagram.edges.length,
            link: artifactLink(artifact.id),
          };
        } catch (err) {
          if (err instanceof DiagramError) return { error: err.message };
          if (err instanceof NotADiagramError) {
            return { error: "That artifact is markdown, not a diagram. Use update_artifact." };
          }
          if (err instanceof ArtifactTooLargeError) return { error: TOO_LARGE };
          if (err instanceof ArtifactAppendOnlyError) return { error: DIAGRAM_APPEND_ONLY };
          if (err instanceof ArtifactRunLimitError) return { error: RUN_LIMIT };
          throw err;
        }
      },
    }),

    delete_artifact: tool({
      description: `Permanently delete one of your artifacts.${appendOnlyNote}`,
      inputSchema: z.object({ id: uuid }),
      execute: async ({ id }) => {
        try {
          const deleted = await deleteArtifact(db, id, writer);
          return deleted ? { id, deleted: true } : { error: "no artifact with that id" };
        } catch (err) {
          if (err instanceof ArtifactAppendOnlyError) return { error: CHAT_ARTIFACT_KEPT };
          throw err;
        }
      },
    }),
  };
}
