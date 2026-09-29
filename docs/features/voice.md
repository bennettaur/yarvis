# Voice

Talk to the assistant and hear it answer. The microphone is on the Chat tab and
in Omni Chat. A spoken message goes to whatever model that chat is set to, in
the same conversation, and shows up in the transcript labeled `spoken`.

## Set up

Voice needs a speech-to-text backend and, if you want spoken replies, a
text-to-speech backend.

- **Local, no key:** run the mlx-audio speech server on your Mac. Follow
  [Running the local speech server](../voice-server.md). It takes about five
  minutes.
- **Cloud:** a Gemini key covers both speech to text and text to speech. A
  Hugging Face token covers speech to text only.

Then set **Speech to text** and **Text to speech** under **Settings → Voice**
and press **Test voice**.

## Use it

1. Open the **Chat** tab, or summon Omni Chat with Control+Shift+Space.
2. Press the **microphone** and speak.
3. Press it again to send. The recording is transcribed and sent as your
   message.

The controls beside the microphone:

- **Speak replies** reads the answer aloud as it streams, one sentence at a
  time. Speech starts about a sentence behind the model, not a whole answer
  behind. Code blocks are skipped.
- **Hands-free** ends your turn after a stretch of silence, and opens the
  microphone again when the reply finishes. It is **off by default** on
  purpose: with it on, anything said in the room can become a message.
- **Stop** ends the turn: it silences speech, drops the recording, and cancels
  the reply.

A recording is capped at 60 seconds. When a recording ends on its own (the
cap, or Hands-free's silence timer) and no speech was heard, it is thrown away
rather than sent. A recording you stop yourself is always sent.

## Safety on spoken turns

You never proofread a transcript the way you proofread typed text. So on a
spoken turn, the assistant asks before anything irreversible:

- deleting a task or forgetting a memory,
- archiving a workspace,
- starting work on an issue, or launching a session,
- filing a JIRA ticket,
- syncing branches,
- sending an instruction to a running session,
- delegating to a specialist.

Every MCP tool asks too, even one you set to auto-approve. The assistant is
told to warn you that it's waiting on an approval. Reading, recalling and creating tasks run
without asking.

## Settings

Settings → Voice:

- **Speech to text:** provider, model, and an optional language.
- **Text to speech:** provider, model and voice.
- **Speak replies** and **Hands-free** defaults.
- **Voice cloning & server-specific fields**: a **Reference clip** and **Extra
  request fields**. See
  [Cloning a voice](../voice-server.md#cloning-a-voice-with-moss-tts-nano).

These are stored in `voiceConfig` in `~/.yarvis/settings.json`, so every
surface shares one setup.

Which models appear in each picker comes from the model catalog. Each model is
tagged with what it can do (`chat`, `stt`, `tts`, `vision`, `embed`). Edit the
tags under **Settings → LLM Providers → Models**. The first edit copies the
built-in list into your settings, and **Reset to built-in list** undoes it.
Model names are free text, in the form `namespace/name` with an optional
`:tag`.

For troubleshooting, see
[the speech server guide](../voice-server.md#troubleshooting).
