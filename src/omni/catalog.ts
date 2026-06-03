import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

/**
 * The Omni component catalog: the single source of truth for the UI the agent
 * is allowed to compose. The same definitions drive both the system prompt sent
 * to the model (`catalog.prompt()`) and the React registry that renders the
 * resulting spec (`./registry`), so prop shapes stay in lock-step.
 *
 * Two kinds of components:
 *  - Layout primitives (Row / Column / Grid / Panel / Heading / Text / Divider)
 *    that arrange and label content.
 *  - Feature widgets (Tasks / Calendar / Memory / PullRequests / Sessions /
 *    Alarms / Settings / Chat) — self-contained, fetch their own data, fill
 *    their pane.
 */

const heightProp = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    "Optional fixed height in pixels. The widget keeps this height and scrolls its own content while the canvas scrolls between widgets. Use to place two of the same widget (e.g. two PrFileDiffs of one PR) and scroll/compare them independently.",
  );

const titled = z.object({
  title: z.string().optional().describe("Optional header shown above the widget"),
  height: heightProp,
});

/**
 * Identifies a single pull request for the decomposed PR-review widgets. Several
 * widgets sharing the same owner/repo/number show different parts of one PR and
 * share a single cached fetch; different numbers render isolated PRs.
 */
const prRef = z.object({
  owner: z.string().describe("Repository owner or org login, e.g. 'facebook'"),
  repo: z.string().describe("Repository name, e.g. 'react'"),
  number: z.number().int().describe("Pull request number"),
  title: z.string().optional().describe("Optional header shown above the widget"),
  height: heightProp,
});

export const catalog = defineCatalog(schema, {
  components: {
    Row: {
      props: z.object({
        gap: z.number().optional().describe("Gap between panes in pixels"),
      }),
      slots: ["default"],
      description:
        "Horizontal split. Fills its parent and divides width equally among its children. Use for side-by-side layouts.",
    },
    Column: {
      props: z.object({
        gap: z.number().optional().describe("Gap between panes in pixels"),
      }),
      slots: ["default"],
      description:
        "Vertical split. Fills its parent and divides height equally among its children. Use to stack rows/widgets, e.g. a row on top and a chat underneath.",
    },
    Grid: {
      props: z.object({
        columns: z
          .number()
          .int()
          .min(1)
          .max(6)
          .optional()
          .describe("Number of equal columns (default 2)"),
        gap: z.number().optional().describe("Gap between cells in pixels"),
      }),
      slots: ["default"],
      description:
        "Equal-column grid that fills its parent. Use for dashboards of several widgets.",
    },
    Panel: {
      props: z.object({
        title: z.string().optional().describe("Optional header for the panel"),
        height: heightProp,
      }),
      slots: ["default"],
      description:
        "A bordered, optionally-titled container for grouping arbitrary content or a single widget.",
    },
    Heading: {
      props: z.object({
        text: z.string(),
        level: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .describe("1 = largest, 3 = smallest (default 2)"),
      }),
      description: "A short title or section heading.",
    },
    Text: {
      props: z.object({
        text: z.string(),
        muted: z.boolean().optional().describe("Render in a dimmer color"),
      }),
      description: "A line or paragraph of plain text.",
    },
    Divider: {
      props: z.object({}),
      description: "A thin horizontal rule between sections.",
    },
    Tasks: {
      props: titled,
      description: "The user's daily and weekly tasks, with inline add/complete. Self-contained.",
    },
    Calendar: {
      props: titled,
      description:
        "Upcoming Google Calendar meetings as an agenda list, with connect and per-event alarm controls. Self-contained.",
    },
    CalendarWeek: {
      props: titled,
      description:
        "A 7-day week view (Sunday–Saturday) of Google Calendar events on a vertical hourly timeline, with a now-line and per-event alarm controls. Prev/Today/Next navigation. Self-contained.",
    },
    CalendarMonth: {
      props: titled,
      description:
        "A month grid of Google Calendar events; each day lists its events with start times and per-event alarm controls. Prev/Today/Next navigation. Self-contained.",
    },
    CalendarDay: {
      props: z.object({
        title: z.string().optional().describe("Optional header shown above the widget"),
        height: heightProp,
        orientation: z
          .enum(["vertical", "horizontal"])
          .optional()
          .describe(
            "Timeline axis direction (default 'vertical'). 'vertical' scrolls up/down; 'horizontal' scrolls left/right.",
          ),
      }),
      description:
        "Today's events as a scrolling timeline with a center now-line and hour markers; upcoming events scroll toward the line as time passes. Per-event alarm controls. Self-contained.",
    },
    Memory: {
      props: titled,
      description:
        "Saved notes, ingested documents, and day/week recaps, with search. Self-contained.",
    },
    PullRequests: {
      props: titled,
      description:
        "GitHub pull request dashboard: authored and review-requested PRs with CI/merge status. Self-contained.",
    },
    PrDescription: {
      props: prRef,
      description:
        "One pull request's description and review comment threads, for the PR named by owner/repo/number.",
    },
    PrChecks: {
      props: prRef,
      description:
        "One pull request's CI/check status list, for the PR named by owner/repo/number.",
    },
    PrFileList: {
      props: prRef,
      description:
        "Compact list of a pull request's changed files (with +/− counts); clicking a file scrolls to its diff. Pairs with PrFileDiffs for the same owner/repo/number.",
    },
    PrFileDiffs: {
      props: prRef,
      description:
        "A pull request's changed files rendered as expandable unified diffs, for the PR named by owner/repo/number.",
    },
    Sessions: {
      props: titled,
      description: "Claude Code session and plan browser for local projects. Self-contained.",
    },
    Alarms: {
      props: titled,
      description: "Scheduled alarms with create/cancel. Self-contained.",
    },
    Settings: {
      props: titled,
      description:
        "System status and API-key settings (sidecar/database health, provider keys). Self-contained.",
    },
    Chat: {
      props: titled,
      description:
        "An interactive assistant chat window with its own session. Can be placed multiple times.",
    },
    Terminal: {
      props: z.object({
        title: z.string().optional().describe("Optional header shown above the widget"),
        sessionId: z
          .string()
          .optional()
          .describe(
            'Stable, unique id for this terminal\'s shell session (e.g. "term-1"). Assign a distinct value to each Terminal and keep it unchanged across edits so its running shell is preserved.',
          ),
      }),
      description:
        "A live shell terminal backed by a real PTY. Self-contained; can be placed multiple times. Give each one a unique, stable sessionId so its shell survives layout changes.",
    },
  },
  // No agent-invokable actions yet: widgets are self-contained and handle their
  // own interactions. The key is required by defineCatalog.
  actions: {},
});

/** The spec type for this catalog, inferred from the schema + component props. */
export type OmniSpec = (typeof catalog)["_specType"];
