import { tool } from "ai";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { ATTENTION_CATEGORIES, type WorkStreamLink, type WorkStreamLinkRef } from "../db/schema.ts";
import { fence, newNonce, untrustedWarning } from "../lib/fencing.ts";
import {
  createStream,
  findStreamsLinkedTo,
  getStream,
  linkToStream,
  listStreams,
  streamOfLink,
  unlinkFromStream,
  updateStream,
  type WorkStreamWithLinks,
} from "./service.ts";
import { DEFAULT_WATCH_EVERY, DEFAULT_WATCH_EXPIRES_IN, watchFields } from "./watches.ts";

/**
 * Work stream tools: the assistant's record of the threads of work it is
 * pushing forward. Not on the MCP endpoint, for the same reason todos aren't:
 * a coding session writing here would be one agent editing another's plan.
 */

/** What a pass is told when it tries to change a stream the user paused. */
export const STREAM_PAUSED =
  "The user paused this stream. Leave it alone until they resume it, and move on to the others.";

/** What a pass is told when it tries to change a watch other than by reporting a check. */
export const WATCH_REPORTED_ONLY =
  "This is a watch: a pass only checks it when it is listed as due, and reports with report_watch.";

const uuid = z.string().uuid();
const priority = z.enum(["urgent", "high", "medium", "low"]);
const status = z.enum(["active", "waiting-on-user", "waiting-on-others", "done", "dropped"]);
const category = z
  .enum(ATTENTION_CATEGORIES)
  .describe(
    "The kind of work: review (someone else's PR), build (the user's own code, PRs, CI, deploys), slack (a chat message to answer) or general. What you raise about the stream is grouped under it",
  );
const instant = z.string().datetime({ offset: true });
const duration = z.string().regex(/^\d+\s*[mhd]$/i, "a duration such as 30m, 3h or 2d");

const watchInput = z
  .object({
    condition: z
      .string()
      .min(1)
      .max(1000)
      .describe(
        "What to look for, in the user's words, specific enough to check with read tools: 'alex has merged both billing PRs (acme/billing#41, #42)'",
      ),
    every: duration
      .optional()
      .describe(
        `How often to check at most, from 15m to 7d; a check waits for the next heads-down pass, so it can be later. Defaults to ${DEFAULT_WATCH_EVERY}`,
      ),
    expiresIn: duration
      .optional()
      .describe(
        `When to give up and tell the user it expired, from now, up to 30d. Defaults to ${DEFAULT_WATCH_EXPIRES_IN}`,
      ),
  })
  .describe(
    "Makes the stream a watch: heads-down passes check the condition on its cadence and tell the user when it is met, then close it",
  );

/** A short piece of text: a ticket key, channel, conversation, message ref or handle. */
const shortText = z.string().min(1).max(300);

/**
 * Only web links: a ref's URL is shown to the user, and another scheme
 * (`javascript:`, `file:`) in a link would run or open something on click.
 */
const webUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL");

export const linkRef = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ticket"),
    provider: z.enum(["github", "jira", "azure-boards"]),
    key: shortText.describe("owner/repo#123, a JIRA key, or an Azure Boards work item id"),
    url: webUrl.optional(),
  }),
  z.object({ kind: z.literal("workspace"), workspaceId: uuid }),
  z.object({
    kind: z.literal("pr"),
    provider: z.enum(["github", "azure"]),
    url: webUrl,
  }),
  z.object({
    kind: z.literal("message"),
    channel: shortText.describe("Where it was sent: slack, teams, email"),
    conversation: shortText.describe("The channel, DM or thread it is in"),
    messageRef: shortText.describe(
      "The message's id or permalink if the tool gave one, otherwise its author and time as shown",
    ),
    author: shortText.optional(),
  }),
  z.object({
    kind: z.literal("review-request"),
    channel: shortText,
    conversation: shortText,
    messageRef: shortText.describe("The request message's id or permalink, or its time as shown"),
    sentAt: instant.describe("When the request was posted"),
    prUrl: webUrl.optional(),
    tagged: z.array(shortText).max(20).optional().describe("Who it tagged, by handle"),
  }),
]);

/**
 * A stream as the model sees it. Every free-text field is fenced: titles come
 * from tickets and PRs, and the notes can quote messages, so all of it is data
 * to weigh against what the tools report now, not instructions.
 */
function presentStream(stream: WorkStreamWithLinks, nonce: string) {
  const text = (value: string | null) => fenceOrNull(value, nonce);
  return {
    id: stream.id,
    kind: stream.kind,
    title: fence(stream.title, nonce),
    status: stream.status,
    paused: stream.pausedAt !== null,
    priority: stream.priority,
    category: stream.category,
    projectId: stream.projectId,
    summary: text(stream.summary),
    nextAction: text(stream.nextAction),
    waitingOn: text(stream.waitingOn),
    wakeAt: stream.wakeAt?.toISOString() ?? null,
    updatedAt: stream.updatedAt.toISOString(),
    ...(stream.kind === "watch"
      ? {
          watch: {
            condition: text(stream.watchCondition),
            everyMinutes: stream.watchEveryMinutes,
            expiresAt: stream.expiresAt?.toISOString() ?? null,
          },
        }
      : {}),
    links: stream.links.map((link) => presentLink(link, nonce)),
  };
}

function fenceOrNull(value: string | null, nonce: string): string | null {
  return value ? fence(value, nonce) : null;
}

/**
 * A ref with its text fields fenced. They were copied from what a tool read
 * (a Slack conversation name, a message author), so they are third-party text
 * too. The ids and kinds the model needs to act on stay as they are.
 */
function presentRef(ref: WorkStreamLinkRef, nonce: string) {
  switch (ref.kind) {
    case "ticket":
      return { ...ref, key: fence(ref.key, nonce) };
    case "workspace":
    case "pr":
      return ref;
    case "message":
      return {
        ...ref,
        channel: fence(ref.channel, nonce),
        conversation: fence(ref.conversation, nonce),
        messageRef: fence(ref.messageRef, nonce),
        author: ref.author ? fence(ref.author, nonce) : undefined,
      };
    case "review-request":
      return {
        ...ref,
        channel: fence(ref.channel, nonce),
        conversation: fence(ref.conversation, nonce),
        messageRef: fence(ref.messageRef, nonce),
        tagged: ref.tagged?.map((handle) => fence(handle, nonce)),
      };
  }
}

function presentLink(link: WorkStreamLink, nonce: string) {
  return {
    id: link.id,
    ref: presentRef(link.ref, nonce),
    title: fenceOrNull(link.title, nonce),
    state: fenceOrNull(link.state, nonce),
    observedAt: link.observedAt?.toISOString() ?? null,
  };
}

/**
 * `unattended` marks the tools a heads-down pass uses: links it makes are
 * recorded as its own, so they don't count as the user's go-ahead.
 */
export function buildWorkStreamTools(
  db: Db,
  { unattended = false }: { unattended?: boolean } = {},
) {
  /** A pass leaves a stream the user paused alone; only the user resumes it. */
  const isPausedForPass = (stream: { pausedAt: Date | null } | null): boolean =>
    unattended && stream !== null && stream.pausedAt !== null;

  return {
    list_work_streams: tool({
      description: `The threads of work you are pushing forward, each with its tickets, workspaces, PRs and messages. Defaults to the open ones (active, waiting on the user, waiting on others), most urgent first, then the ones untouched longest. ${
        unattended
          ? "Streams the user paused are left out."
          : "A paused stream is one heads-down mode leaves alone until the user resumes it. Watches (kind 'watch') are listed too; drop one to cancel it."
      } Pass awakeOnly to leave out streams whose wakeAt hasn't come yet.`,
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
          excludePaused: unattended,
          // A pass is handed the watches due a check in its prompt instead.
          kind: unattended ? "work" : undefined,
        });
        const nonce = newNonce();
        return {
          warning: untrustedWarning(nonce),
          streams: streams.map((s) => presentStream(s, nonce)),
        };
      },
    }),

    get_work_stream: tool({
      description: "One work stream in full, including its links and your notes on it.",
      inputSchema: z.object({ id: uuid }),
      execute: async ({ id }) => {
        const stream = await getStream(db, id);
        if (!stream) return { error: "no work stream with that id" };
        if (isPausedForPass(stream)) return { error: STREAM_PAUSED };
        const nonce = newNonce();
        return {
          warning: untrustedWarning(nonce),
          stream: {
            ...presentStream(stream, nonce),
            notes: stream.notes.map((n) => ({ at: n.at, text: fence(n.text, nonce) })),
          },
        };
      },
    }),

    create_work_stream: tool({
      description: `Start tracking a thread of work you will push forward: a ticket to implement, a message that needs an answer, a PR to get reviewed. Check list_work_streams and find_work_streams_for first, so the same work isn't tracked twice. Link its tickets, workspaces, PRs and messages with link_to_work_stream.${
        unattended
          ? ""
          : " With watch, it is a watch instead: a one-off 'tell me when…' the user asked for, such as 'let me know when Alex merges his PRs'. Heads-down passes check it and tell the user when it is met, so it is only checked while heads-down mode is on; say so if it is off. Set category to what the watch is about."
      }`,
      inputSchema: z.object({
        title: z.string().min(1).max(300),
        summary: z.string().max(2000).optional().describe("What the work is and why it matters"),
        priority: priority.optional(),
        category: category.optional(),
        projectId: uuid.optional().describe("The project it serves, if any"),
        nextAction: z.string().max(1000).optional().describe("The next step you mean to take"),
        note: z.string().max(2000).optional(),
        watch: watchInput.optional(),
      }),
      execute: async ({ watch, ...input }) => {
        // A watch is something the user asked to hear about, not one a pass makes up.
        if (unattended && watch) return { error: "only the user sets up a watch" };
        const fields = watch ? watchFields(watch) : undefined;
        if (fields && "error" in fields) return fields;
        const stream = await createStream(db, { ...input, watch: fields });
        return {
          id: stream.id,
          kind: stream.kind,
          status: stream.status,
          priority: stream.priority,
          ...(stream.expiresAt ? { expiresAt: stream.expiresAt.toISOString() } : {}),
        };
      },
    }),

    update_work_stream: tool({
      description:
        "Move a work stream along. Set status 'waiting-on-user' with waitingOn when it needs the user, 'waiting-on-others' when it waits on a reviewer or another team, back to 'active' when you can push it again, 'done' when finished, 'dropped' when it no longer matters. Set wakeAt when it isn't worth looking at before a time, such as bumping a review request the next morning. A note is appended, never replaces the earlier ones.",
      inputSchema: z.object({
        id: uuid,
        status: status.optional(),
        priority: priority.optional(),
        category: category.optional(),
        title: z.string().min(1).max(300).optional(),
        summary: z.string().max(2000).nullable().optional(),
        projectId: uuid.nullable().optional(),
        nextAction: z.string().max(1000).nullable().optional(),
        waitingOn: z.string().max(500).nullable().optional(),
        wakeAt: instant.nullable().optional(),
        paused: z
          .boolean()
          .optional()
          .describe(
            "Pause the stream so heads-down mode leaves it alone, or resume it. Only when the user asks.",
          ),
        note: z.string().max(2000).optional(),
      }),
      execute: async ({ id, wakeAt, ...patch }) => {
        if (unattended && patch.paused !== undefined) {
          return { error: "only the user pauses or resumes a stream" };
        }
        const current = await getStream(db, id);
        if (!current) return { error: "no work stream with that id" };
        if (isPausedForPass(current)) return { error: STREAM_PAUSED };
        if (unattended && current.kind === "watch") return { error: WATCH_REPORTED_ONLY };
        // Whether a stream is open decides what heads-down mode may act on, so
        // only the user brings back one that was closed.
        if (
          unattended &&
          patch.status &&
          !["done", "dropped"].includes(patch.status) &&
          ["done", "dropped"].includes(current.status)
        ) {
          return { error: "a closed stream can only be reopened by the user" };
        }
        const wakeAtDate = wakeAt === undefined ? undefined : wakeAt ? new Date(wakeAt) : null;
        const stream = await updateStream(
          db,
          id,
          { ...patch, wakeAt: wakeAtDate },
          { unlessPaused: unattended },
        );
        // Gone, or paused by the user since it was read above.
        if (!stream) return { error: unattended ? STREAM_PAUSED : "no work stream with that id" };
        return { id: stream.id, status: stream.status, priority: stream.priority };
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
        const stream = await getStream(db, streamId);
        if (!stream) return { error: "no work stream with that id" };
        if (isPausedForPass(stream)) return { error: STREAM_PAUSED };
        if (unattended && stream.kind === "watch") return { error: WATCH_REPORTED_ONLY };
        const link = await linkToStream(db, streamId, {
          ref,
          title,
          state,
          createdBy: unattended ? "heads-down" : "chat",
        });
        return { id: link.id, kind: link.kind };
      },
    }),

    unlink_from_work_stream: tool({
      description: "Remove a link that turned out not to belong to the stream.",
      inputSchema: z.object({ linkId: uuid }),
      execute: async ({ linkId }) => {
        const stream = await streamOfLink(db, linkId);
        if (isPausedForPass(stream)) return { error: STREAM_PAUSED };
        if (unattended && stream?.kind === "watch") return { error: WATCH_REPORTED_ONLY };
        return (await unlinkFromStream(db, linkId))
          ? { linkId, removed: true }
          : { error: "no link with that id" };
      },
    }),

    find_work_streams_for: tool({
      description:
        "Which work streams a ticket, workspace, PR or message is already linked to. Use it before creating a stream, and when something needs attention, to find the stream it belongs to.",
      inputSchema: z.object({ ref: linkRef }),
      execute: async ({ ref }) => {
        const streams = (await findStreamsLinkedTo(db, ref)).filter((s) => !isPausedForPass(s));
        const nonce = newNonce();
        return {
          warning: untrustedWarning(nonce),
          streams: streams.map((s) => ({
            id: s.id,
            title: fence(s.title, nonce),
            status: s.status,
            paused: s.pausedAt !== null,
          })),
        };
      },
    }),
  };
}
