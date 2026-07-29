import { tool } from "ai";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
  buildIssuePrompt,
  sanitizeIssueText,
  upsertLink,
  writeIssuePrompt,
} from "../issues/service.ts";
import {
  type ClaudeSessionStarter,
  startClaudeSession as defaultStartClaudeSession,
} from "../workspaces/claudeSession.ts";
import { defaultGitRunner, type GitRunner } from "../workspaces/git.ts";
import { createWorkspace, getWorkspace, provisionWorkspace } from "../workspaces/service.ts";
import { isAllowedJiraBaseUrl, JiraClient } from "./client.ts";
import { applyJiraStartWorkSideEffects } from "./service.ts";
import type { JiraIssueDetail } from "./types.ts";

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Issue key: project key + number, e.g. "PROJ-45". */
const issueKeyArg = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*-\d+$/, "expected a JIRA issue key like PROJ-45");

/**
 * Injectable collaborators, overridden in tests to avoid real network/claude/git,
 * plus the one piece of per-turn context the tools need.
 */
export interface JiraToolDeps {
  /** Overrides the JIRA client; defaults to one built from the configured
   *  secrets (null when JIRA isn't configured). */
  jiraClient?: JiraClient | null;
  startClaudeSession?: ClaudeSessionStarter;
  gitRunner?: GitRunner;
  /** Whether sessions these tools start get Remote Control; see
   *  `WorkspaceToolDeps.remoteControl`. Defaults to off. */
  remoteControl?: boolean;
}

/** Builds a JIRA client from configured secrets, or null when unconfigured. */
function clientFromConfig(config: Config): JiraClient | null {
  const { jiraBaseUrl, jiraEmail, jiraApiToken } = config.secrets;
  if (!jiraBaseUrl || !jiraEmail || !jiraApiToken) return null;
  if (!isAllowedJiraBaseUrl(jiraBaseUrl)) return null;
  return new JiraClient(jiraBaseUrl, jiraEmail, jiraApiToken);
}

/**
 * JIRA tools for the chat agent: search issues by JQL, read one issue, create an
 * issue, and start work on a ticket (create + provision a workspace, seed the
 * issue prompt, assign + transition the issue, and launch a Claude Code
 * session) — the JIRA analogue of the GitHub issue tools. Free-text,
 * third-party-authored fields (summaries, descriptions, comments, display
 * names, labels) are run through `sanitizeIssueText` before reaching the model,
 * since ticket content could otherwise smuggle hidden instructions.
 */
export function buildJiraTools(db: Db, config: Config, deps: JiraToolDeps = {}) {
  const startClaude = deps.startClaudeSession ?? defaultStartClaudeSession;
  const gitRunner = deps.gitRunner ?? defaultGitRunner;
  const remoteControl = deps.remoteControl ?? false;
  const jira: JiraClient | null =
    deps.jiraClient !== undefined ? deps.jiraClient : clientFromConfig(config);

  const launchClaude = async (detail: Awaited<ReturnType<typeof getWorkspace>>) => {
    if (!detail) return { error: "workspace vanished after creation" };
    try {
      const session = await startClaude({
        workspaceId: detail.id,
        cwd: detail.rootPath,
        name: detail.name,
        remoteControl,
      });
      return {
        workspaceId: detail.id,
        name: detail.name,
        status: detail.status,
        repos: detail.repos.map((r) => r.repo.name),
        sessionName: detail.name,
        sessionKey: session.sessionKey,
        message: remoteControl
          ? `Started a remote-controllable Claude Code session in workspace "${detail.name}". Open it from claude.ai/code or the Claude mobile app by the name "${detail.name}", or view it live in the Workspaces tab.`
          : `Started a Claude Code session in workspace "${detail.name}". View it live in the Workspaces tab.`,
      };
    } catch (e) {
      return {
        error: errorMessage(e),
        workspaceId: detail.id,
        name: detail.name,
        status: detail.status,
        note: "Workspace is ready; the Claude session failed to start. You can open the workspace locally and start Claude there.",
      };
    }
  };

  return {
    jira_search_issues: tool({
      description:
        'Search JIRA issues with a JQL query and return each issue\'s key, summary, status, type, assignee, reporter, labels, and url. Use JQL like "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC" or "project = PROJ AND text ~ \'login\'". Requires JIRA to be configured in Settings.',
      inputSchema: z.object({
        jql: z.string().min(1).describe("A JQL query string"),
      }),
      execute: async ({ jql }) => {
        if (!jira) return { error: "JIRA not configured in Settings" };
        try {
          const issues = await jira.searchIssues(jql);
          // Free-text, third-party-authored fields (summary, display names,
          // labels) are sanitized; status/type/project are JIRA-controlled
          // identifiers rendered verbatim.
          return issues.map((i) => ({
            key: i.externalId,
            summary: sanitizeIssueText(i.title),
            status: i.statusName,
            type: i.issueType,
            project: i.sourceKey,
            assignee: i.assignees[0] ? sanitizeIssueText(i.assignees[0]) : null,
            reporter: sanitizeIssueText(i.author),
            labels: i.labels.map((l) => sanitizeIssueText(l.name)),
            url: i.url,
          }));
        } catch (e) {
          return { error: errorMessage(e) };
        }
      },
    }),

    jira_get_issue: tool({
      description:
        "Read one JIRA issue by key (e.g. PROJ-45): its summary, description, status, type, priority, assignee, reporter, labels, linked issues, and comments. Requires JIRA to be configured.",
      inputSchema: z.object({ key: issueKeyArg.describe("Issue key, e.g. PROJ-45") }),
      execute: async ({ key }) => {
        if (!jira) return { error: "JIRA not configured in Settings" };
        try {
          const d = await jira.issueDetail(key);
          return {
            key: d.externalId,
            summary: sanitizeIssueText(d.title),
            description: sanitizeIssueText(d.body),
            status: d.statusName,
            type: d.issueType,
            priority: d.priority,
            assignee: d.assignee ? sanitizeIssueText(d.assignee) : null,
            reporter: sanitizeIssueText(d.reporter),
            labels: d.labels.map((l) => sanitizeIssueText(l.name)),
            url: d.url,
            linkedIssues: d.linkedIssues.map((l) => ({
              key: l.key,
              relation: l.linkType,
              summary: sanitizeIssueText(l.summary),
              status: l.statusName,
            })),
            comments: d.comments.map((c) => ({
              author: c.author,
              body: sanitizeIssueText(c.body),
              createdAt: c.createdAt,
            })),
          };
        } catch (e) {
          return { error: errorMessage(e) };
        }
      },
    }),

    jira_create_issue: tool({
      description:
        "Create a JIRA issue in a project. Provide the project key, a summary, an issue type name (e.g. 'Task', 'Bug', 'Story'), and an optional description. Returns the created issue's key and url. Requires JIRA to be configured.",
      inputSchema: z.object({
        projectKey: z
          .string()
          .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "expected a project key like PROJ")
          .describe("The project key, e.g. PROJ"),
        summary: z.string().min(1).max(255).describe("Short issue summary/title"),
        issueTypeName: z.string().min(1).describe("Issue type name, e.g. 'Task', 'Bug', 'Story'"),
        description: z.string().optional().describe("Optional issue description (plain text)"),
      }),
      execute: async ({ projectKey, summary, issueTypeName, description }) => {
        if (!jira) return { error: "JIRA not configured in Settings" };
        try {
          const created = await jira.createIssue({
            projectKey,
            summary,
            issueTypeName,
            description,
          });
          return {
            key: created.externalId,
            summary: sanitizeIssueText(created.title),
            status: created.statusName,
            url: created.url,
          };
        } catch (e) {
          return { error: errorMessage(e) };
        }
      },
    }),

    jira_start_work_on_issue: tool({
      description:
        "Start work on a JIRA issue like the 'Start work' button on the issue view: create a workspace, provision it, seed the issue details into .yarvis/issue-prompt.md, assign the issue to the user and transition it to in-progress (best-effort), and start a remote-controllable Claude Code session in it. Because a JIRA ticket isn't tied to a repo, pass the repo ids to include (resolve them with list_repos); pass an empty list for a scratch workspace with no repo. Requires JIRA to be configured.",
      inputSchema: z.object({
        key: issueKeyArg.describe("Issue key, e.g. PROJ-45"),
        repoIds: z
          .array(z.string().uuid())
          .default([])
          .describe(
            "Ids of registered repos to include (from list_repos); empty for a scratch workspace",
          ),
        assignSelf: z.boolean().default(true).describe("Assign the issue to the user in JIRA"),
        transitionToInProgress: z
          .boolean()
          .default(true)
          .describe("Transition the issue into an in-progress status in JIRA"),
      }),
      execute: async ({ key, repoIds, assignSelf, transitionToInProgress }) => {
        if (!jira) return { error: "JIRA not configured in Settings" };

        let issue: JiraIssueDetail;
        try {
          issue = await jira.issueDetail(key);
        } catch (e) {
          return { error: `could not load issue ${key}: ${errorMessage(e)}` };
        }

        const ws = await createWorkspace(db, config, { name: issue.title, repoIds });
        await provisionWorkspace(db, ws.id, () => undefined, gitRunner);

        const detail = await getWorkspace(db, ws.id);
        if (!detail) return { error: "workspace vanished after creation" };
        if (detail.status !== "active") {
          const failures = detail.repos
            .filter((r) => r.status === "error")
            .map((r) => ({ repo: r.repo.name, message: r.error ?? "unknown error" }));
          return {
            error: "workspace provisioning failed; work not started",
            workspaceId: ws.id,
            status: detail.status,
            failures,
          };
        }

        await upsertLink(db, {
          provider: "jira",
          sourceKey: issue.sourceKey,
          externalId: issue.externalId,
          title: issue.title,
          url: issue.url,
          workspaceId: ws.id,
          localStatus: "in_progress",
        });

        const warnings = await applyJiraStartWorkSideEffects(jira, key, {
          assignSelf,
          transitionToInProgress,
        });

        const prompt = buildIssuePrompt({
          displayId: issue.displayId,
          title: issue.title,
          url: issue.url,
          body: issue.body,
          sourceKey: issue.sourceKey,
        });
        try {
          await writeIssuePrompt(detail.rootPath, prompt);
        } catch (e) {
          warnings.push(`could not write issue prompt: ${errorMessage(e)}`);
        }

        const launch = await launchClaude(detail);
        return {
          ...launch,
          issue: { key, summary: sanitizeIssueText(issue.title), url: issue.url },
          warnings,
          promptFile: ".yarvis/issue-prompt.md",
          nextStep:
            "In the session, tell Claude to read .yarvis/issue-prompt.md and implement the ticket.",
        };
      },
    }),
  };
}
