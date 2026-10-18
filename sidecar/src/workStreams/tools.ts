import { tool } from "ai";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import type { WorkStreamLink } from "../db/schema.ts";
import { fence, newNonce, untrustedWarning } from "../lib/fencing.ts";
import {
  createStream,
  getStream,
  linkToStream,
  listStreams,
  streamsLinkedTo,
  unlink,
  updateStream,
  type WorkStreamWithLinks,
} from "./service.ts";

/**
 * Work stream tools: the assistant's record of the threads of work it is
 * pushing forward. Not on the MCP endpoint, for the same reason todos aren't:
 * a coding session writing here would be one agent editing another's plan.
 */

const uuid = z.string().uuid();
const priority = z.enum(["urgent", "high", "medium", "low"]);
const status = z.enum(["active", "waiting-on-user", "waiting-on-others", "done", "dropped"]);
const instant = z.string().datetime({ offset: true });

/** One line of text naming a channel, conversation or message. */
const name = z.string().min(1).max(300);

const linkRef = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ticket"),
    provider: z.enum(["github", "jira", "azure-boards"]),
    key: name.describe("owner/repo#123, a JIRA key, or an Azure Boards work item id"),
    url: z.string().url().optional(),
  }),
  z.object({ kind: z.literal("workspace"), workspaceId: uuid }),
  z.object({
    kind: z.literal("pr"),
    provider: z.enum(["github", "azure"]),
    url: z.string().url(),
  }),
  z.object({
    kind: z.literal("message"),
    channel: name.describe("Where it was sent: slack, teams, email"),
    conversation: name.describe("The channel, DM or thread it is in"),
    messageRef: name.describe(
      "The message's id or permalink if the tool gave one, otherwise its author and time as shown",
    ),
    author: name.optional(),
  }),
  z.object({
    kind: z.literal("review-request"),
    channel: name,
    conversation: name,
    messageRef: name.describe("The request message's id or permalink, or its time as shown"),
    sentAt: instant.describe("When the request was posted"),
    prUrl: z.string().url().optional(),
    tagged: z.array(name).max(20).optional().describe("Who it tagged, by handle"),
  }),
]);

/**
 * A stream as the model sees it. Every free-text field is fenced: titles come
 * from tickets and PRs, and the notes can quote messages, so all of it is data
 * to weigh against what the tools report now, not instructions.
 */
function present(stream: WorkStreamWithLinks, nonce: string) {
  const text = (value: string | null) => (value ? fence(value, nonce) : null);
  return {
    id: stream.id,
    title: fence(stream.title, nonce),
    status: stream.status,
    priority: stream.priority,
    projectId: stream.projectId,
    summary: text(stream.summary),
    nextAction: text(stream.nextAction),
    waitingOn: text(stream.waitingOn),
    wakeAt: stream.wakeAt?.toISOString() ?? null,
    updatedAt: stream.updatedAt.toISOString(),
    links: stream.links.map((link) => presentLink(link, nonce)),
  };
}

function presentLink(link: WorkStreamLink, nonce: string) {
  return {
    id: link.id,
    ref: link.ref,
    title: link.title ? fence(link.title, nonce) : null,
    state: link.state ? fence(link.state, nonce) : null,
    observedAt: link.observedAt?.toISOString() ?? null,
  };
}

export function buildWorkStreamTools(db: Db) {
  return {
    list_work_streams: tool({
      description:
        "The threads of work you are pushing forward, each with its tickets, workspaces, PRs and messages. Defaults to the open ones (active, waiting on the user, waiting on others), most urgent first, then the ones untouched longest. Pass awakeOnly to leave out streams whose wakeAt hasn't come yet.",
      inputSchema: z.object({
        statuses: z.array(status).optional().describe("Defaults to the open ones"),
        projectId: uuid.optional(),
        awakeOnly: z.boolean().optional(),
      }),
      execute: async ({ statuses, projectId, awakeOnly }) => {
        const streams = await listStreams(db, {
          statuses,
          projectId,
          awakeAt: awakeOnly ? new Date() : undefined,
        });
        const nonce = newNonce();
        return {
          warning: untrustedWarning(nonce),
          streams: streams.map((s) => present(s, nonce)),
        };
      },
    }),

    get_work_stream: tool({
      description: "One work stream in full, including its links and your notes on it.",
      inputSchema: z.object({ id: uuid }),
      execute: async ({ id }) => {
        const stream = await getStream(db, id);
        if (!stream) return { error: "no work stream with that id" };
        const nonce = newNonce();
        return {
          warning: untrustedWarning(nonce),
          stream: {
            ...present(stream, nonce),
            notes: stream.notes.map((n) => ({ at: n.at, text: fence(n.text, nonce) })),
          },
        };
      },
    }),

    create_work_stream: tool({
      description:
        "Start tracking a thread of work you will push forward: a ticket to implement, a message that needs an answer, a PR to get reviewed. Check list_work_streams and find_work_streams_for first, so the same work isn't tracked twice. Link its tickets, workspaces, PRs and messages with link_to_work_stream.",
      inputSchema: z.object({
        title: z.string().min(1).max(300),
        summary: z.string().max(2000).optional().describe("What the work is and why it matters"),
        priority: priority.optional(),
        projectId: uuid.optional().describe("The project it serves, if any"),
        nextAction: z.string().max(1000).optional().describe("The next step you mean to take"),
        note: z.string().max(2000).optional(),
      }),
      execute: async (input) => {
        const stream = await createStream(db, input);
        return { id: stream.id, status: stream.status, priority: stream.priority };
      },
    }),

    update_work_stream: tool({
      description:
        "Move a work stream along. Set status 'waiting-on-user' with waitingOn when it needs the user, 'waiting-on-others' when it waits on a reviewer or another team, back to 'active' when you can push it again, 'done' when finished, 'dropped' when it no longer matters. Set wakeAt when it isn't worth looking at before a time, such as bumping a review request the next morning. A note is appended, never replaces the earlier ones.",
      inputSchema: z.object({
        id: uuid,
        status: status.optional(),
        priority: priority.optional(),
        title: z.string().min(1).max(300).optional(),
        summary: z.string().max(2000).optional(),
        nextAction: z.string().max(1000).nullable().optional(),
        waitingOn: z.string().max(500).nullable().optional(),
        wakeAt: instant.nullable().optional(),
        note: z.string().max(2000).optional(),
      }),
      execute: async ({ id, wakeAt, ...patch }) => {
        const stream = await updateStream(db, id, {
          ...patch,
          ...(wakeAt !== undefined ? { wakeAt: wakeAt ? new Date(wakeAt) : null } : {}),
        });
        return stream
          ? { id: stream.id, status: stream.status, priority: stream.priority }
          : { error: "no work stream with that id" };
      },
    }),

    link_to_work_stream: tool({
      description:
        "Link a ticket, workspace, PR, message or review request to a work stream, or update the link when it is already there. Record what you last saw of it in state ('CI failing', 'approved', 'no reply yet'). A review request records when it was posted, so you can tell when it is due a bump; a bump is a new message, so link it as a new review request.",
      inputSchema: z.object({
        streamId: uuid,
        ref: linkRef,
        title: z.string().max(300).optional().describe("The ticket or PR title, or the channel"),
        state: z.string().max(300).optional(),
      }),
      execute: async ({ streamId, ref, title, state }) => {
        if (!(await getStream(db, streamId))) return { error: "no work stream with that id" };
        const link = await linkToStream(db, streamId, { ref, title, state });
        return { id: link.id, kind: link.kind };
      },
    }),

    unlink_from_work_stream: tool({
      description: "Remove a link that turned out not to belong to the stream.",
      inputSchema: z.object({ linkId: uuid }),
      execute: async ({ linkId }) =>
        (await unlink(db, linkId)) ? { linkId, removed: true } : { error: "no link with that id" },
    }),

    find_work_streams_for: tool({
      description:
        "Which work streams a ticket, workspace, PR or message is already linked to. Use it before creating a stream, and when something needs attention, to find the stream it belongs to.",
      inputSchema: z.object({ ref: linkRef }),
      execute: async ({ ref }) => {
        const streams = await streamsLinkedTo(db, ref);
        const nonce = newNonce();
        return {
          warning: untrustedWarning(nonce),
          streams: streams.map((s) => ({
            id: s.id,
            title: fence(s.title, nonce),
            status: s.status,
          })),
        };
      },
    }),
  };
}
