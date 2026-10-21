# Chat and Omni Chat

There are two ways to type to [the assistant](assistant.md):

- the **Chat** tab, a full-page chat with a session list,
- **Omni Chat**, a chat overlay you can summon over any screen. It sees
  what you're looking at.

Both use the same agent, the same tools and the same memory. They also share
the provider and model you last picked.

## Omni Chat

Press **Control+Shift+Space** from anywhere, even when Yarvis is in the
background. The window comes forward and a chat panel opens in the middle of it.
You can also open it from the chat button at the bottom of the nav rail, or
from **Help → Ask Yarvis** (the **?** below it).

- **It knows what's on screen.** When you send a message, Omni Chat attaches a
  short description of the current view. On a PR, that is the PR's number,
  title, repo, author and link. On an issue, it is the issue. On the calendar,
  it is the view you're on. So you can ask "what's risky in this PR?" or "make
  a task for this ticket" without pasting anything.
- **It keeps going when hidden.** Press Esc or click outside to hide it. A reply
  in progress keeps streaming. Summon it again and you're back in the same
  conversation.
- **New chat** starts a fresh session.
- **Links to places in Yarvis work.** Ask "where do I add a GitHub token?" and
  the answer links straight to the page, such as **Settings → Credentials**.
  Clicking one hides Omni Chat so you can see the page. The Chat tab's links
  work the same way.

The screen description is capped at a few thousand characters and is sent only
with that turn. It is never saved to the chat history, and the assistant
treats it as data, not instructions.

Only the PRs, Issues and Calendar views describe themselves in detail today.
Other tabs only say which tab you're on.

## The Chat tab

Open it with **Cmd+1**. At the top:

- **New chat**, and a **session** dropdown to go back to an earlier chat.
- **Thinking** shows the model's reasoning, for providers that return it.
- The **provider** and **model** pickers. A provider with no key saved shows
  "(no key)" and can't be picked.

The Chat tab stays loaded when you switch tabs, so a long answer keeps
streaming while you do something else.

### Sending

- **Enter** sends. **Shift+Enter** adds a new line.
- While a reply is running, **Send** becomes **Stop**. Stopping discards the
  partial reply and saves nothing for that turn.
- If a turn fails, **Retry** sends the same message again.

There is no file attachment yet. Paste text, or ingest a document under
**Memory → Ingest document**.

### Seeing what it did

Above each reply is a list of the tools the assistant called: the tool name,
which MCP server it came from, whether it worked, and how long it took. Click a
row to see the arguments and the result. When the reply starts, the list folds
into one line, for example "Used 4 tool calls". Reasoning, when the provider
returns it, shows as a "Thinking…" block you can expand.

Messages you spoke are labeled `spoken`. Messages relayed from Telegram are
labeled with the Telegram user.

### Approving tool calls

When a tool call needs your approval, an amber **Approve?** bar appears above
the message box. It shows one call at a time, with a count of how many are waiting.

- **A** approves, and **D** denies. The keys are ignored while you're typing,
  and for a moment after a new call appears, so a keystroke meant for something
  else doesn't answer it.
- **Arguments** shows exactly what the tool will be called with.
- **Always allow** (MCP tools only) saves your consent for that tool, so it
  stops asking.

See [What it asks before doing](assistant.md#what-it-asks-before-doing) for
which calls ask.

### Long conversations

A chat that grows past the model's context window is **compacted**, not cut
off. Yarvis summarizes the older messages and keeps the last few word for word.
The chat on screen doesn't change. The threshold is **Summarize the chat
past (tokens)** under **Settings → Assistant → Turn budget** (default 200,000). Some models
come with a lower threshold of their own, which takes precedence.

The same section sets **Tool-calling steps per turn** (default 100) and
**Cap the reply length** (off by default). A turn that runs out of steps ends with no reply, so the
default is set high.

### Voice

Both chat surfaces have a microphone button. See [Voice](voice.md).

## Recaps and notes

Two related buttons live on **Memory → Memories**:

- **Recap: Today / This week** writes a short summary of the tasks you
  completed and the notes you took, using the chat's current model.
- **Quick note** saves a `note` memory. Notes feed the recaps.
