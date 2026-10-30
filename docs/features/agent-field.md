# Agent Field

Agent Field is an 8-bit visualizer for what your agents are doing right now.
Every Claude Code session in a workspace and every part of Yarvis that is
working gets a node orbiting a central core. Each prompt, tool call, error and
finished turn sends shapes across the screen. A chiptune soundtrack plays
along. The busier the agents get, the faster and louder the field and the
music get.

Open it from the **Agent Field** tab in the nav rail.

## Use it

1. Open the **Agent Field** tab.
2. Click the field, or press any key, to start the audio. The browser engine
   won't play sound until you do.
3. Work as usual. Nodes appear as agents start and fade out after about 90
   seconds with nothing to report.

Leaving the tab stops the field and the music.

A robot marks a Claude Code session. A brain marks Yarvis's own work.

| Node | What it is |
| --- | --- |
| Robot, named `workspace:abcd` | A Claude Code session in that workspace. A subagent adds `/type`. |
| Brain, named after a surface | Chat turns from `chat` (the Chat tab and Omni Chat), `voice`, `telegram`, `browser`, `heads-down` or `scheduled-task` |
| Brain, named after a specialist | A run you or the assistant delegated to that specialist |
| Brain, named `job …` | A scheduled job running |

## Keys

| Key | Action |
| --- | --- |
| S | Mute or unmute |
| D | Demo traffic on or off |
| A | Set the intensity by hand with a slider |
| 1–8 | Fire test events (read, edit, bash, search, spawn, subagent done, done, error) |
| H | Hide the HUD |
| F | Fullscreen |

The keys do nothing while you're typing in a text field, or with Cmd,
Control or Option held.

Above about 90% intensity the field flashes quickly and sometimes inverts its
colors. Press **A** and lower the slider if that bothers you.

## Where the events come from

Claude Code sessions report through hooks that Yarvis writes into each
workspace's `.claude/settings.json`, beside the ones that raise attention
flags. They run in the background and never hold the session up. A workspace
gets them when it is provisioned, or when the assistant starts a session in
it. A session already running when the hooks were added reports once it is
restarted. Claude Code sessions outside a Yarvis workspace don't appear.

What is sent is the tool's name and a short label, such as a file's name or
the start of a command. Values that look like secrets are masked. Nothing is
stored: an event nobody is watching is dropped.
