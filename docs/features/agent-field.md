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

Leaving the tab stops the field and the music. If the page can't reach
Yarvis's background service, it plays demo traffic until it can.

A robot marks a Claude Code session. A brain marks Yarvis's own work.

| Node | What it is |
| --- | --- |
| Robot, named `workspace:abcd` | A Claude Code session in that workspace. A subagent adds `/type`. |
| Brain, named after a surface | Chat turns, from surfaces such as `chat` (the Chat tab and Omni Chat), `voice`, `telegram`, `browser`, `heads-down` and `scheduled-task` |
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

The keys do nothing while you're typing in a text field, while a dialog or
Omni Chat has focus, or with Cmd, Control, Option or Shift held.

The field flashes. An error flashes the screen red and glitches it at any
intensity. Crossing about 55% sets off a bright white flash. Above about 65%
the picture glitches more and more often, and above about 92% whole frames
sometimes invert. Turn on **Reduce motion** in macOS's Accessibility settings
to drop the flashes, glitches and inverted frames, or press **A** and keep the
slider low.

## Where the events come from

Claude Code sessions report through hooks that Yarvis writes into each
workspace's `.claude/settings.json`, beside the ones that raise attention
flags. They run in the background and never hold the session up. A workspace
gets them when it is provisioned, or when the assistant starts a session in
it. A session already running when the hooks were added reports once it is
restarted. Claude Code sessions outside a Yarvis workspace don't appear.

Each hook hands its input to Yarvis on your machine, which keeps only the
tool's name and a short label: a file's name, a command's program (not its
arguments), or a URL's host. Values that look like secrets are masked.
Nothing is stored: an event nobody is watching is dropped.

Each Yarvis window shows its own activity. With a second instance running
(`bun run dev:instance`), a scheduled job shows on whichever instance ran it.
