# Omni view

Omni view is a canvas you build by describing it. Ask for "my PRs next to
today's calendar and my tasks", and the model lays out live Yarvis widgets to
match. You can save a layout and load it later, which makes it a good way to
build a personal dashboard, or a review screen for one PR.

Omni view is not the same as [Omni Chat](quick-chat.md), the chat overlay.

Open it from the **Omni** tab (Cmd+2).

## Use it

1. Open the **Omni** tab. The canvas is on the left, and the **Builder** panel
   is on the right.
2. Pick a provider and model in the Builder. These are shared with the Chat
   tab.
3. Describe the layout you want and press **Build**. The canvas fills in as the
   model streams its answer.
4. Send follow-ups to change it: "make the calendar a week view", "put the PR
   diffs under the file list".
5. To keep it, type a name under **Save current layout as…** and press
   **Save**. Saving under a name that already exists replaces that layout.
6. Load a saved layout from the **load layout** dropdown. Loading clears the
   Builder conversation.

The current layout survives switching tabs and restarting the app. Drag the
divider to resize the canvas, or collapse the Builder to give it the full
width.

Some prompts to start from:

- "Today's calendar on the left, my tasks and open PRs stacked on the right."
- "A review screen for bennettaur/yarvis#351: description, checks, file list,
  and diffs."
- "My workspaces list above two terminals side by side."

## Widgets

The model can only use these widgets:

| Group | Widgets |
| --- | --- |
| Layout | Row, Column, Grid (1–6 columns), Panel, Heading, Text, Divider |
| Your day | Tasks, Calendar (agenda), CalendarWeek, CalendarMonth, CalendarDay, Alarms, Memory |
| Pull requests | PullRequests (the full list) |
| One PR (GitHub) | PrDescription, PrChecks, PrFileList, PrFileDiffs |
| Work | WorkspaceList, Workspace, Terminal, Sessions |
| Other | Chat, Settings (the same status view as the Dashboard) |

The one-PR widgets take an owner, repo and number, and widgets for the same PR
share their data. Clicking a file in a PrFileList jumps to it in the
PrFileDiffs beside it. Most widgets take a height, so two can scroll on their
own.

Each widget except Terminal shows a small badge with its type. A Terminal
widget takes a session id and always uses its default height.

## Limits

- **The builder model has no tools.** It can't look anything up, so it doesn't
  know your workspace ids or PR numbers. Name the PR (`owner/repo#123`) or
  workspace in your prompt.
- **The one-PR widgets are GitHub only.**
- **A Chat widget starts a new, empty conversation** each time the layout
  loads.
- **Saved layouts need the database.** Without it, the layout list is empty.
