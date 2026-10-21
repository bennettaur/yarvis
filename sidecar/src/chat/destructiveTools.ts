/**
 * Built-in tools that need the user's explicit go-ahead on an unproof-read turn.
 *
 * A typed turn is read before it is sent; a spoken one is not. Speech recognition
 * mishears, and a hands-free microphone can pick up a sentence the user never
 * addressed to the assistant — so on a voice turn the words reaching the model
 * are not reliably the words the user chose. That is fine for the great majority
 * of the tool surface, which is read-only or trivially undone.
 *
 * These are the ones where it is not: each either cannot be undone, or is
 * visible to people outside this machine, or hands control to an agent session
 * that can do both. They keep working from the Voice tab — they just surface the
 * same approval prompt that MCP tools already use, so the user sees the exact
 * operation before it happens.
 */
/**
 * Built-in tools that need approval on *every* turn, typed or spoken.
 *
 * The set below is about whether the words reaching the model are the words the
 * user chose. This one is about reach: a tool here acts on people outside this
 * machine and cannot be taken back, so the question "did the user actually ask
 * for this" has to be answered by the user rather than inferred from a turn they
 * may have composed after reading an injected PR title or event payload.
 */
export const ALWAYS_CONFIRM_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  // Puts a meeting on someone else's calendar and mails everyone invited, and
  // there is deliberately no tool to move or cancel it afterwards.
  "create_calendar_event",
  // Saves a remote that later tools clone and run setup scripts from. The name
  // may come from an issue or other injected text, or be a squatted look-alike,
  // so the user confirms the exact remote before any of its code can arrive.
  "register_repo",
  // Starts an unattended loop that starts work, files tickets and instructs
  // agent sessions on its own until it is stopped.
  "start_heads_down",
]);

export const DESTRUCTIVE_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  // Irreversible, and the system prompt describes it as permanent and unlogged.
  "delete_task",
  // Tears down worktrees on disk.
  "archive_workspace",
  // Assigns and labels an issue other people can see, then provisions for it.
  "start_work_on_issue",
  "jira_start_work_on_issue",
  // Each writes to a tracker shared with other people, under the user's name.
  "jira_create_issue",
  "jira_update_issue",
  "jira_transition_issue",
  "jira_assign_issue",
  "jira_comment_on_issue",
  "create_repo_issue",
  "update_repo_issue",
  "comment_on_repo_issue",
  "azure_boards_create_work_item",
  "azure_boards_update_work_item",
  "azure_boards_assign_work_item",
  "azure_boards_comment_on_work_item",
  // Each launches an agent session, which can edit and push code on its own.
  "create_workspace_session",
  "create_scratch_workspace_session",
  "start_workspace_session",
  // Clones code that an auto-mode agent will read, and can start a kick-off
  // session a failed provision still owed.
  "add_repo_to_workspace",
  // Merges and pushes across every active workspace by default, publishing a
  // branch that had never been pushed before.
  "sync_workspaces_with_base",
  // Submits text at a running agent's prompt. Delivery is all it confirms — the
  // session may have been showing a dialog that the text answers instead — so a
  // misheard instruction is both unreviewable and unrecoverable.
  "send_workspace_instruction",
  // Act inside the user's signed-in browser session. The extension keeps them on
  // the current site and off destructive controls, but a misheard "open the
  // billing page" is still an action nobody reviewed.
  "click_browser_element",
  "navigate_browser_tab",
  // Deletes a memory outright, where correcting one keeps the trail.
  "forget_memory",
  // Stores an answer that later turns act on without asking, typed ones
  // included, so a misheard "yes" would outlive the turn it was heard in.
  "record_decision",
  // Runs a whole specialist with its own tools; a misheard task becomes a
  // multi-step run nobody reviewed.
  "delegate",
]);

/**
 * The only built-ins a scheduled task's turn is offered.
 *
 * A scheduled task runs a prompt the model wrote for itself, often just after
 * reading a CI log or a PR comment, and nobody is watching it run. Dropping the
 * tools above is not enough there: a memory or task written on that turn is read
 * back on later turns as though the user had agreed to it. So the turn gets what
 * it needs to look, report and look again, and nothing that writes. The
 * browser tools are left out too: they read the user's signed-in tabs, and what
 * a task reads can end up in a notification.
 */
export const SCHEDULED_TASK_TOOLS: ReadonlySet<string> = new Set([
  "schedule_task",
  "list_scheduled_tasks",
  "cancel_scheduled_task",
  "request_attention",
  "list_tasks",
  "recall",
  "list_memories",
  "list_projects",
  "get_project",
  "list_project_items",
  "list_todos",
  "get_todo",
  "list_work_streams",
  "get_work_stream",
  "find_work_streams_for",
  "heads_down_status",
  "search_events",
  "activity_summary",
  "find_dangling_work",
  "work_summary",
  "list_repos",
  "list_repo_issues",
  "list_workspaces",
  "get_workspace_activity",
  "get_workspace_status",
  "jira_search_issues",
  "jira_get_issue",
  "get_repo_issue",
  "list_pr_reviews",
  "search_pr_insights",
  "list_calendar_events",
]);
