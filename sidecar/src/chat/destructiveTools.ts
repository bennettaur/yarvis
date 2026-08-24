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
]);

export const DESTRUCTIVE_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  // Irreversible, and the system prompt describes it as permanent and unlogged.
  "delete_task",
  // Tears down worktrees on disk.
  "archive_workspace",
  // Assigns and labels an issue other people can see, then provisions for it.
  "start_work_on_issue",
  "jira_start_work_on_issue",
  // Writes to a tracker shared with other people.
  "jira_create_issue",
  // Each launches an agent session, which can edit and push code on its own.
  "create_workspace_session",
  "create_scratch_workspace_session",
  "start_workspace_session",
  // Merges and pushes across every active workspace by default, publishing a
  // branch that had never been pushed before.
  "sync_workspaces_with_base",
  // Submits text at a running agent's prompt. Delivery is all it confirms — the
  // session may have been showing a dialog that the text answers instead — so a
  // misheard instruction is both unreviewable and unrecoverable.
  "send_workspace_instruction",
  // Deletes a memory outright, where correcting one keeps the trail.
  "forget_memory",
  // Runs a whole specialist with its own tools; a misheard task becomes a
  // multi-step run nobody reviewed.
  "delegate",
]);
