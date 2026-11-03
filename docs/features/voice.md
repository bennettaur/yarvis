# Voice

Talk to the assistant and hear it answer. The microphone is on the Chat tab and
in Omni Chat. A spoken message goes to whatever model that chat is set to, in
the same conversation, and shows up in the transcript labeled `spoken`.

## Set up

Voice needs a speech-to-text backend and, if you want spoken replies, a
text-to-speech backend.

- **Local, no key:** run the mlx-audio speech server on your Mac. The quickest
  way is the **Voice** page: press **Start**, then **Use for voice**. See
  [Running the local speech server](../voice-server.md) for what that does and
  how to run it yourself instead.
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
- **Continuous** keeps the microphone open and sends each turn when you
  finish talking, so you don't press anything between turns. See
  [Continuous mode](#continuous-mode). It is **off by default** on purpose:
  with it on, anything said in the room can become a message.
- **Stop** ends the turn: it silences speech, drops the recording, and cancels
  the reply.

A push-to-talk recording is capped at 60 seconds. When the cap ends a
recording and no speech was heard, it is thrown away rather than sent. A
recording you stop yourself is always sent.

## Continuous mode

Tick **Continuous**, then press the microphone once. It stays open until you
press it again or press **Stop**.

Yarvis decides when you've finished a turn in two steps:

1. [Silero VAD](https://github.com/snakers4/silero-vad) listens for speech and
   for pauses in it.
2. At each pause, [Smart Turn](https://github.com/pipecat-ai/smart-turn) judges
   from your tone and phrasing whether you're done or only thinking. "Can you
   draw the login flow?" ends a turn about a third of a second after you stop.
   "I want to add, um…" doesn't.

If Smart Turn keeps saying you aren't done, 3 seconds of silence ends the turn
anyway. A turn is capped at 60 seconds.

While the assistant is replying:

- What you say is still heard. A turn you finish mid-reply shows as
  **queued**, and is sent when the reply ends. Several queued turns go as one
  message.
- Starting to talk stops the spoken reply, and the rest of that reply isn't
  spoken. The text still arrives. That's true even before the reply starts
  speaking, while the assistant is still thinking.
- A turn that starts over the spoken reply, or within a second and a half of
  it ending, and mostly repeats its words is dropped: it's the reply leaking
  back into the microphone, not you. A one-word turn that is also a word of the
  reply, like "yes", is dropped too. This is a check on the transcript, so a
  badly misheard echo can still get through as a turn.

Switching to another tab, closing Omni Chat, or opening Omni Chat over the Chat
tab closes the microphone, and drops queued turns.

Both models run on your Mac in a small Python process the app starts the first
time you use continuous mode. It needs [uv](https://docs.astral.sh/uv/)
(`brew install uv`). The first start installs its Python packages (a few
hundred MB, once) and downloads both models (about 10 MB) into the Hugging Face
cache, so it can take a few minutes. The status beside the microphone says **Starting turn detection…**
until it's ready. The process listens only on `127.0.0.1`, needs a token the
app gives it, and stops when Yarvis quits. Only the finished turn's audio
goes on to your speech-to-text provider.

If a spoken reply keeps cutting itself off, the microphone is hearing the
speakers. Use headphones.

## The Voice page

The **Voice** tab in the nav rail has three parts.

### Local speech server

- **Start** and **Stop** run the mlx-audio server on `127.0.0.1` at the port
  shown (8000 by default). It needs [uv](https://docs.astral.sh/uv/)
  (`brew install uv`). The first start downloads the server's Python packages,
  so it takes a while.
- If an mlx-audio server you started yourself already answers on that port,
  the page says **Running (started elsewhere)**. One another Yarvis instance
  started says which instance. Yarvis uses either but only the instance that
  started a server can stop it.
- If some other program answers on the port, the page says **Port in use**
  and won't use it. Choose a different port.
- **Use for voice** adds the server under **Settings → LLM Providers** as
  `Local speech` and tags its models for speech. If speech to text or text to
  speech isn't set yet, it also picks the starter models.
- **Models** lists the verified local models. **Download** fetches one into the
  Hugging Face cache, so its first use doesn't stall. **Server output** shows
  the server's log.

A server Yarvis started stops when Yarvis quits.

### Voices

A saved voice is a name, a text-to-speech provider and model, an optional voice
id, and an optional clip to clone from.

- **Record clip** records up to 15 seconds from the microphone. Press it again
  to stop. **Upload clip** takes any audio file. Either way, Yarvis converts
  the clip to 16 kHz mono WAV and stores it in `~/.yarvis/voices/`. **Play
  clip** plays the stored clip back, so you can check it before cloning from it.
- **Clip sent as** decides how the clip reaches the server. **File path** is for
  mlx-audio, which reads the file itself. **Inline audio** sends the audio in
  the request, which is what vLLM-Omni expects. A file path is only sent to a
  server on this machine; a remote provider always gets the audio, since the
  path would name your home folder.
- **Activate** makes replies speak in that voice on every surface. With no voice
  active, replies use the text-to-speech settings in **Settings → Voice**.
- **Test** plays a short phrase in the voice.

### Studio

Type some text, tick the voices to use, and press **Generate**. You get one take
per voice, each with a player.

- **Save** copies a take to `~/Downloads/Yarvis Voice/`. **Show in Finder**
  opens that folder.
- Each **Generate** deletes the previous takes. Saved copies in Downloads stay.
- **Translate to** speaks a translation instead. Pick the chat model that
  translates under **Translation provider** and **Translation model**. The
  translation is shown above the takes.

## Safety on spoken turns

You never proofread a transcript the way you proofread typed text. So on a
spoken turn, the assistant asks before anything irreversible:

- deleting a task or forgetting a memory,
- archiving a workspace,
- starting work on an issue, or launching a session,
- adding a repo to a workspace,
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
- **Speak replies** and **Continuous** defaults.
- **Voice cloning & server-specific fields**: a **Reference clip** and **Extra
  request fields**. See
  [Cloning a voice](../voice-server.md#cloning-a-voice-with-moss-tts-nano).

These are stored in `voiceConfig` in `~/.yarvis/settings.json`, so every
surface shares one setup. Saved voices are under `voiceProfiles` in the same
file, and the server's port under `speechServer`.

Which models appear in each picker comes from the model catalog. Each model is
tagged with what it can do (`chat`, `stt`, `tts`, `vision`, `embed`, `decision`). Edit the
tags under **Settings → LLM Providers → Models**. The first edit copies the
built-in list into your settings, and **Reset to built-in list** undoes it.
Model names are free text, in the form `namespace/name` with an optional
`:tag`.

For troubleshooting, see
[the speech server guide](../voice-server.md#troubleshooting).
