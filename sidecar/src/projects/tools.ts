import { tool } from "ai";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  addProjectItem,
  listProjectItems,
  listProjects,
  projectOverview,
  removeProjectItem,
  updateProject,
  updateProjectItem,
  upsertProject,
} from "./service.ts";

/**
 * Project tools: the structured half of "tell me about the project". The agent
 * keeps the tickets, their priorities and the current focus here, and the
 * narrative in memory — so a planning turn can read a project's state without
 * hoping the right paragraph comes back from a semantic search.
 */

const priority = z.enum(["urgent", "high", "medium", "low"]);
const uuid = z.string().uuid();

export function buildProjectTools(db: Db) {
  return {
    upsert_project: tool({
      description:
        "Create a project the user describes, or return the existing one with that name (matched case-insensitively). Use this first when they start talking about a named piece of work, then hang tickets and tasks off the id it returns.",
      inputSchema: z.object({
        name: z.string().min(1).max(120).describe("What the user calls this project"),
        summary: z
          .string()
          .max(2000)
          .optional()
          .describe("What the project is, in a sentence or two"),
        focus: z.string().max(500).optional().describe("What they are trying to get done next"),
        repoIds: z.array(uuid).optional().describe("Repo ids the work lands in (from list_repos)"),
      }),
      execute: async ({ name, summary, focus, repoIds }) => {
        const { project, created } = await upsertProject(db, { name, summary, focus, repoIds });
        return {
          id: project.id,
          name: project.name,
          status: project.status,
          focus: project.focus,
          created,
        };
      },
    }),

    list_projects: tool({
      description:
        "List the user's projects, newest-touched first. Use it to resolve a name to an id, or to answer what they have on.",
      inputSchema: z.object({
        status: z.enum(["active", "paused", "shipped", "abandoned"]).optional(),
      }),
      execute: async ({ status }) => {
        const rows = await listProjects(db, { status });
        return rows.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          focus: p.focus,
          summary: p.summary,
        }));
      },
    }),

    get_project: tool({
      description:
        "Everything tracked against one project: its focus, its outstanding tickets by priority, and the user's open tasks for it. This is what to read before suggesting what to work on.",
      inputSchema: z.object({ projectId: uuid }),
      execute: async ({ projectId }) => {
        const overview = await projectOverview(db, projectId);
        if (!overview) return { error: "no project with that id" };
        return {
          project: {
            id: overview.project.id,
            name: overview.project.name,
            status: overview.project.status,
            summary: overview.project.summary,
            focus: overview.project.focus,
          },
          items: overview.items.map((i) => ({
            id: i.id,
            kind: i.kind,
            externalKey: i.externalKey,
            title: i.title,
            priority: i.priority,
            note: i.note,
          })),
          openTasks: overview.openTasks.map((t) => ({
            id: t.id,
            title: t.title,
            scope: t.scope,
            targetDate: t.targetDate,
          })),
        };
      },
    }),

    update_project: tool({
      description:
        "Update a project's status, summary, or current focus — e.g. when the user says what this week is about, or that a project shipped or is on hold.",
      inputSchema: z.object({
        projectId: uuid,
        status: z.enum(["active", "paused", "shipped", "abandoned"]).optional(),
        summary: z.string().max(2000).optional(),
        focus: z.string().max(500).optional(),
      }),
      execute: async ({ projectId, ...patch }) => {
        const project = await updateProject(db, projectId, patch);
        return project
          ? { id: project.id, name: project.name, status: project.status, focus: project.focus }
          : { error: "no project with that id" };
      },
    }),

    track_project_item: tool({
      description:
        "Track a ticket against a project with the priority the user gave it. Pass the provider-native key (a JIRA key like PROJ-45, or owner/repo#123) so re-tracking the same ticket updates it rather than adding a second copy. Only the pointer and priority are stored — the ticket's own state stays in JIRA/GitHub.",
      inputSchema: z.object({
        projectId: uuid,
        kind: z.enum(["jira", "github", "pr", "note"]),
        externalKey: z
          .string()
          .max(200)
          .optional()
          .describe("JIRA key, owner/repo#number, or omitted for a bare note"),
        title: z.string().min(1).max(500),
        priority: priority.optional(),
        note: z
          .string()
          .max(1000)
          .optional()
          .describe("The user's own status, e.g. 'blocked on review'"),
      }),
      execute: async ({ projectId, kind, externalKey, title, priority: p, note }) => {
        const item = await addProjectItem(db, {
          projectId,
          kind,
          externalKey,
          title,
          priority: p,
          note,
        });
        return { id: item.id, externalKey: item.externalKey, priority: item.priority };
      },
    }),

    update_project_item: tool({
      description:
        "Change a tracked ticket's priority or note, or mark it done (or reopen it). Marking it done here records that the user considers it finished; it does not transition the ticket in JIRA or close it on GitHub.",
      inputSchema: z.object({
        itemId: uuid,
        priority: priority.optional(),
        note: z.string().max(1000).optional(),
        done: z.boolean().optional(),
      }),
      execute: async ({ itemId, ...patch }) => {
        const item = await updateProjectItem(db, itemId, patch);
        return item
          ? { id: item.id, priority: item.priority, done: item.doneAt !== null }
          : { error: "no item with that id" };
      },
    }),

    untrack_project_item: tool({
      description:
        "Stop tracking a ticket against a project. Use when it was added by mistake; prefer marking it done when the work actually happened.",
      inputSchema: z.object({ itemId: uuid }),
      execute: async ({ itemId }) => {
        const removed = await removeProjectItem(db, itemId);
        return removed ? { itemId, removed: true } : { error: "no item with that id" };
      },
    }),

    list_project_items: tool({
      description: "The tickets tracked against a project, most urgent first.",
      inputSchema: z.object({
        projectId: uuid,
        includeDone: z.boolean().optional(),
      }),
      execute: async ({ projectId, includeDone }) => {
        const items = await listProjectItems(db, projectId, { includeDone });
        return items.map((i) => ({
          id: i.id,
          kind: i.kind,
          externalKey: i.externalKey,
          title: i.title,
          priority: i.priority,
          note: i.note,
          done: i.doneAt !== null,
        }));
      },
    }),
  };
}
