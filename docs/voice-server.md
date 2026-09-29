# Running the local speech server

Yarvis can listen to you and speak its answers. It needs two things for that:

- **Speech to text (STT)** turns your recording into a chat message.
- **Text to speech (TTS)** reads the reply back to you.

Both can run on your own Mac, with no API key and nothing sent to the cloud.
This guide sets up [mlx-audio](https://github.com/Blaizzy/mlx-audio), which
serves both on one port through an OpenAI-compatible `/v1/audio` API.

Voice is optional. Skip this whole page if you don't want it. For how to use
voice once it works, see [Voice](features/voice.md).

## Requirements

- An Apple Silicon Mac (M1 or later). mlx-audio uses Apple's MLX framework and
  does not run on Intel Macs.
- [uv](https://docs.astral.sh/uv/). Install it with `brew install uv`. uv
  downloads the Python version the server needs (3.12+) on its own.
- About 2 GB of free disk for the default models. They download the first time
  they are used and are cached under `~/.cache/huggingface`.

The repo pins the server's Python dependencies in `pyproject.toml` and
`uv.lock`, so you don't install anything by hand.

## 1. Install and start the server

From the repo root:

```bash
uv sync
uv run mlx_audio.server --host 127.0.0.1 --port 8000
```

`uv sync` creates `.venv/` in the repo (it is gitignored). The second command
starts the server in the foreground. Leave it running in its own terminal.

Keep `--host 127.0.0.1`. That binds the server to your machine only, so
nothing else on your network can reach it. The server has no authentication,
so any program on your Mac can still use it. Only leave it running if you're
fine with that.

## 2. Point Yarvis at it

In the Yarvis app:

1. Open **Settings → LLM Providers** and press **Add provider**. Fill in:
   - **Name:** `local speech` (any name works)
   - **Base URL:** `http://127.0.0.1:8000/v1`
   - **API protocol:** either OpenAI option. Speech uses the OpenAI audio API
     whichever you pick.
   - Leave **Models** empty. Speech models are picked in the next step.
2. Open **Settings → Voice** and set both **Speech to text** and **Text to
   speech** to the `local speech` provider:
   - **Speech to text** model: `mlx-community/whisper-large-v3-turbo-asr-fp16`
   - **Text to speech** model: `mlx-community/Soprano-1.1-80M-bf16`
3. Press **Test voice**. You should hear a sentence. The first call downloads
   the model weights, so it can take a minute or two.
4. Open the **Chat** tab and press the microphone button.

These settings are saved to the `voiceConfig` section of
`~/.yarvis/settings.json`, so every chat surface uses the same setup.

## 3. Keep it running (optional)

Yarvis does not start the speech server for you yet
([#228](https://github.com/bennettaur/yarvis/issues/228)). You have two options:

- **Start it by hand** when you want voice. A Yarvis Terminal tab works well for
  this.
- **Run it as a login item** with `launchd`, so it is always up.

For the `launchd` option, save the file below as
`~/Library/LaunchAgents/com.yarvis.speech.plist`. Change `/opt/homebrew/bin/uv`
to the output of `which uv`, `/Users/you/dev/yarvis` to your clone of the repo,
and `/Users/you` in the log paths to your home folder.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.yarvis.speech</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/uv</string>
    <string>run</string>
    <string>mlx_audio.server</string>
    <string>--host</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>8000</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/you/dev/yarvis</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/yarvis-speech.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/yarvis-speech.log</string>
</dict>
</plist>
```

Then load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.yarvis.speech.plist
```

To stop it for good:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.yarvis.speech.plist
```

The server's output goes to `~/Library/Logs/yarvis-speech.log`.

## Choosing other models

These are verified on Apple Silicon through the server above:

| Purpose | Model | Notes |
| --- | --- | --- |
| Text to speech | `mlx-community/Soprano-1.1-80M-bf16` | Small and needs no extra setup. Start here. |
| Text to speech | `mlx-community/Kokoro-82M-bf16` | Nicer voice. Set **Voice** to `af_heart`. Needs the espeak-ng fix below. |
| Text to speech | `mlx-community/MOSS-TTS-Nano-100M` | Can clone a voice from a short clip. See below. |
| Speech to text | `mlx-community/whisper-large-v3-turbo-asr-fp16` | Served by the same server. |
| Speech to text | `gemma4:latest` through Ollama | If you already run Ollama, add it as a provider at `http://localhost:11434/v1`. |

Model names are free text, because a local server names its own models. They
take the form `namespace/name` with an optional `:tag` (`whisper:latest`).
That shape keeps a model name from pointing anywhere except the model
endpoint.

Which models a provider offers is set in **Settings → LLM Providers → Models**.
Each model carries tags (`chat`, `stt`, `tts`, `vision`, `embed`) that decide
where it shows up. Only a `tts` model can speak, and only a `chat` model can
answer a message.

### Cloud options

- **Gemini** can do both speech to text and text to speech with the same API
  key you use for chat. Pick a
  Gemini chat model for speech to text and a `-tts` model for text to speech.
  **Voice** takes one of Gemini's voice names, such as `Kore`, `Puck` or
  `Zephyr`. Blank uses `Kore`.

  Gemini has no audio endpoint. Yarvis asks `generateContent` for audio output
  to speak, and attaches the recording to an ordinary request to transcribe.
  That's why Gemini's chat models appear under speech to text. On Gemini,
  **Extra request fields** become generation-config fields rather than
  top-level ones.
- **Hugging Face** works for speech to text only
  (`openai/whisper-large-v3-turbo`), with a token entered in Settings.

## Cloning a voice with MOSS-TTS-Nano

MOSS-TTS-Nano speaks in the voice of a short reference recording.

1. Record five to ten seconds of normal speech. It needs no script.
2. Save it as a mono WAV at **16, 24 or 48 kHz**. Do not use 44.1 kHz (see
   below).
3. In **Settings → Voice**, open **Voice cloning & server-specific fields**.
   Leave **Reference clip** empty and put the file's path in **Extra request
   fields**:
   ```json
   {"ref_audio": "/Users/you/voice-samples/reference.wav"}
   ```

Neither field can change the model or the text being spoken.

mlx-audio wants a path on disk. The **Reference clip** field sends the audio as
base64 instead, which is what vLLM-Omni on an NVIDIA machine expects.

**Why not 44.1 kHz:** a 44.1 kHz clip doesn't cause an error. Instead, the
server returns about a minute of rambling audio for a short sentence. 44.1 kHz is the default for Voice Memos
and QuickTime, so check your file. To make a test clip at a safe rate:

```bash
say -o ref.wav --data-format=LEI16@16000 "any sentence at all"
```

## Troubleshooting

Start with **Test voice** in Settings → Voice. It plays a fixed phrase and
shows the backend's own error message.

- **Connection refused.** The server isn't running, or it's on another port.
  Check the terminal where you started it.
- **The first test takes a long time.** The model is downloading. Watch the
  server's output.
- **"the speech provider returned no audio".** The server failed after it
  started answering. Its own log has the real error.
- **Kokoro fails with `espeakng_loader//phontab: No such file or directory`.**
  Kokoro looks for its data one directory above where it is installed.
  Installing espeak-ng with Homebrew does not help. Either use Soprano, or link
  the data where Kokoro looks:
  ```bash
  cd .venv/lib/python3.*/site-packages/espeakng_loader && ln -sf espeak-ng-data/* .
  ```
- **"ffmpeg not found".** Only mp3 output needs ffmpeg. Yarvis asks for WAV, so
  you only see this if you set `response_format` yourself in Extra request
  fields.
- **"Failed to load image or audio file" (Ollama).** A format problem. Yarvis
  converts every recording to 16 kHz mono WAV before sending it, so this
  usually means a hand-built request rather than the app.
- **"Model not supported by provider hf-inference".** Hugging Face doesn't serve
  that text-to-speech model. Use the local server.
- **A cloned voice rambles for a minute.** The reference clip is probably
  44.1 kHz. Resample it to 16 kHz.
- **No microphone permission prompt.** Under `bun run tauri dev` the app isn't
  bundled, so macOS attributes the prompt to the terminal that launched it.
  Check **System Settings → Privacy & Security → Microphone** for your terminal,
  or run a built app.

## Running MOSS through vLLM instead (untested)

On Linux with an NVIDIA GPU, vLLM-Omni serves MOSS-TTS-Nano over the same
OpenAI-compatible API:

```bash
vllm serve OpenMOSS-Team/MOSS-TTS-Nano --omni --port 8091
```

Add a provider at `http://localhost:8091/v1` and use the **Reference clip**
field. vLLM-Omni needs a clip on every request and ignores the Voice field.

The community [vllm-metal](https://github.com/vllm-project/vllm-metal) plugin
runs vLLM on Apple Silicon, but it documents no audio support, so this path
probably doesn't work on a Mac. Use mlx-audio there.
