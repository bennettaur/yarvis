import { tool } from "ai";
import { z } from "zod";
import { hasReadUntrusted, type UntrustedReads } from "../chat/destructiveTools.ts";
import type { Db } from "../db/client.ts";
import type { Artifact } from "../db/schema.ts";
import { fence, newNonce, untrustedWarning } from "../lib/fencing.ts";
import {
  DiagramError,
  diagramChangesSchema,
  ELEMENT_TYPES,
  elementPatchSchema,
  MAX_DIAGRAM_ELEMENTS,
  parseDiagram,
} from "./diagram.ts";
import { describeScene } from "./scene.ts";
import {
  ARTIFACT_LIST_LIMIT,
  ArtifactAppendOnlyError,
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
  NotADocumentError,
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
  "This diagram came from a chat with the user, so you can only add new elements to it. Start a new diagram to change or remove what is there.";

const DIAGRAM_FORMAT = `It is an Excalidraw scene, written as Excalidraw element skeletons (what convertToExcalidrawElements takes). Every element needs an id you pick, e.g. "api" or "api-db", which update_diagram uses to change it. Types:
- rectangle, ellipse, diamond: x, y, width, height; label {text, fontSize, textAlign, verticalAlign, strokeColor} draws text inside, and the shape grows downward to fit it.
- text: x, y, text, fontSize, textAlign.
- arrow: start {id} and end {id} bind it to two different shapes, and it is drawn straight between their outlines, following them when they move. Unbound, give x, y and points ([[0, 0], [dx, dy], ...], relative to x and y). startArrowhead/endArrowhead: arrow (the default end), bar, dot, circle, triangle, diamond, or null for none. label {text, fontSize}.
- line: x, y and points; it can't bind, carry a label or have arrowheads.
- frame: children (ids), name. Each of x, y, width and height you leave out is fitted to the children, and arrows bound to a child are put in the frame too, so an arrow out of a frame stretches it.
Style on every type but frame: strokeColor, backgroundColor (hex like "#a5d8ff", or "transparent"), fillStyle (solid, hachure, cross-hatch, zigzag), strokeWidth, strokeStyle (solid, dashed, dotted), roughness (0 is clean, 1 the default sketchy look), opacity (0-100), angle (radians), groupIds, and roundness: {type: 3} rounds a shape's corners, {type: 2} curves an arrow or line through its points. Text is always drawn in Helvetica, and other Excalidraw properties are dropped.
Coordinates are pixels and y grows downward. Later elements are drawn on top of earlier ones. The pane shows the diagram in dark mode by inverting its colours, so pick colours for a white background. Up to ${MAX_DIAGRAM_ELEMENTS} elements.`;

const SCENE_HINT =
  "The result describes where every element ended up (text sizes are estimates) and lists problems: overlaps, labels that don't fit, arrows that cross a shape. Check it, and fix what you didn't mean with update_diagram.";

const DIAGRAM_NOT_TEXT =
  "That artifact is a diagram. Change it with update_diagram; update_artifact can't edit its content.";

const NOT_A_DIAGRAM = "That artifact is a document, not a diagram. Use update_artifact.";

const DIAGRAM_TOO_LARGE = `That would make the diagram longer than ${MAX_ARTIFACT_CHARS} characters. Shorten labels, or split it into two diagrams.`;

/**
 * The address the chat renders as a link that opens the artifact beside the
 * conversation. `src/lib/artifactLink.ts` parses it.
 */
function artifactLink(id: string): string {
  return `yarvis://artifact/${id}`;
}

/**
 * What the model sees of a diagram after a change or read. Labels and ids may
 * come from an unattended run, so the scene and the problems are both fenced.
 */
function sceneOf(artifact: Artifact, reads: UntrustedReads | undefined) {
  if (reads && artifact.untrusted) reads.hasReadUntrustedArtifact = true;
  const scene = describeScene(parseDiagram(artifact.content));
  const nonce = newNonce();
  return {
    warning: untrustedWarning(nonce),
    bounds: scene.bounds,
    scene: fence(scene.elements.join("\n"), nonce),
    problems: fence(scene.problems.join("\n") || "none", nonce),
  };
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
        "Read one of your artifacts in full. A diagram's content is its JSON elements, and the result also describes where each one is drawn and what looks wrong; read it before update_diagram so you use the ids already there.",
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
          ...(artifact.format === "excalidraw"
            ? (({ bounds, problems }) => ({
                bounds,
                problems: fence(problems.join("\n") || "none", nonce),
              }))(describeScene(parseDiagram(artifact.content)))
            : {}),
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
          if (err instanceof NotADocumentError) return { error: DIAGRAM_NOT_TEXT };
          if (err instanceof ArtifactTooLargeError) return { error: TOO_LARGE };
          if (err instanceof ArtifactAppendOnlyError) return { error: APPEND_ONLY };
          if (err instanceof ArtifactRunLimitError) return { error: RUN_LIMIT };
          throw err;
        }
      },
    }),

    create_diagram: tool({
      description: `Draw a diagram the user can watch and come back to: an architecture sketch, a flow, a plan of how pieces connect. ${DIAGRAM_FORMAT} ${SCENE_HINT} ${LINK_HINT}`,
      inputSchema: z.object({
        title: title.describe("Short and specific, e.g. 'Checkout service architecture'"),
        elements: z
          .array(elementPatchSchema.extend({ type: z.enum(ELEMENT_TYPES) }))
          .max(MAX_DIAGRAM_ELEMENTS),
      }),
      execute: async ({ title: t, elements }) => {
        try {
          const artifact = await createDiagram(db, {
            title: t,
            elements,
            writer,
            untrusted: tainted(),
          });
          return {
            id: artifact.id,
            title: artifact.title,
            link: artifactLink(artifact.id),
            ...sceneOf(artifact, reads),
          };
        } catch (err) {
          if (err instanceof DiagramError) return { error: err.message };
          if (err instanceof ArtifactTooLargeError) return { error: DIAGRAM_TOO_LARGE };
          throw err;
        }
      },
    }),

    update_diagram: tool({
      description: `Change one of your diagrams in place; the user sees each change as it lands if they have it open. upsert takes elements by id: for an id that exists, the properties you send replace those on the element and the rest are kept (null clears one, except an arrowhead or roundness, where null means none); a new id adds an element, which needs a type and what that type requires. remove deletes elements by id; removing a shape also removes the arrows bound to it. Removals run first, then upserts in order. The format is the one create_diagram describes, and get_artifact shows the current elements. ${SCENE_HINT} Set addOnly when every id you upsert is new and you remove nothing: such a change doesn't need the user's approval, and it is refused if it would touch an existing element.${
        writer === "chat"
          ? ""
          : " You can only add new elements to a diagram that came from a chat with the user."
      }`,
      inputSchema: diagramChangesSchema.extend({
        id: uuid,
        title: title.optional(),
        addOnly: z
          .boolean()
          .optional()
          .describe("True when this change only adds new nodes and edges"),
      }),
      execute: async ({ id, title: t, addOnly, ...changes }) => {
        try {
          const artifact = await updateDiagram(db, id, {
            title: t,
            changes,
            addOnly,
            writer,
            untrusted: tainted(),
          });
          if (!artifact) return { error: "no artifact with that id" };
          return { id: artifact.id, link: artifactLink(artifact.id), ...sceneOf(artifact, reads) };
        } catch (err) {
          if (err instanceof DiagramError) return { error: err.message };
          if (err instanceof NotADiagramError) return { error: NOT_A_DIAGRAM };
          if (err instanceof ArtifactTooLargeError) return { error: DIAGRAM_TOO_LARGE };
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
