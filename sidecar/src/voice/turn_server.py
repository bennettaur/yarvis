# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "numpy==2.5.4",
#     "onnxruntime==1.31.1",
#     "websockets==15.0.1",
#     "huggingface_hub==0.36.2",
#     # Only for WhisperFeatureExtractor, which smart-turn was trained on. It
#     # runs on numpy, so torch is not needed.
#     "transformers==4.57.6",
# ]
#
# [tool.uv]
# # Exact versions above, and a cutoff for what they pull in, so every machine
# # installs the same code and a later bad release can't reach this process.
# exclude-newer = "2026-11-01T00:00:00Z"
# ///
"""Turn detection for Yarvis's continuous voice mode.

The webview streams 16 kHz mono int16 PCM over a loopback websocket. Silero VAD
marks speech and pauses, and smart-turn decides at each pause whether the user
finished their turn or is only thinking. A finished turn goes back to the
webview as its audio, which the webview transcribes with the configured
speech-to-text provider.

The sidecar starts this with `uv run --script`, passing a random token in
YARVIS_TURN_TOKEN that every connection must present. It prints
`YARVIS_TURN_READY <port>` once the models are loaded and it is listening, and
exits when its stdin closes, so a sidecar killed without warning doesn't leave
it running.

Protocol, per connection:
  client -> server  binary: int16 little-endian PCM, 16 kHz mono, any length
                    text:   ignored
  server -> client  text:   {"type": "speech_start"}
                            {"type": "pause", "probability": p}
                            {"type": "turn", "reason": r, "probability": p|null}
                    binary: the turn's PCM, sent right after each "turn"

  `reason` is "complete" (smart-turn judged it finished), "silence" or "cap";
  `probability` is null for the last two. `pause` is for debugging with a
  websocket client; the webview ignores it.
"""

import asyncio
import hmac
import json
import os
import sys
from collections import deque
from urllib.parse import parse_qs, urlparse

# Set before transformers loads: it warns at import that no torch is installed,
# which is expected here and would only clutter the server log.
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
from huggingface_hub import hf_hub_download  # noqa: E402
from transformers import WhisperFeatureExtractor  # noqa: E402
from websockets.asyncio.server import ServerConnection, serve  # noqa: E402
from websockets.http11 import Request, Response  # noqa: E402

ort.disable_telemetry_events()

SAMPLE_RATE = 16_000

# Pinned to a commit so a model update upstream can't change behaviour, or
# what is downloaded, without a change here.
SILERO_REPO = "onnx-community/silero-vad"
SILERO_REVISION = "e71cae966052b992a7eca6b17738916ce0eca4ec"
SILERO_FILE = "onnx/model.onnx"
SMART_TURN_REPO = "pipecat-ai/smart-turn-v3"
SMART_TURN_REVISION = "f766f81d3cfdf7737ac64aad813d91bbfd56bf93"
SMART_TURN_FILE = "smart-turn-v3.2-cpu.onnx"

# Silero v5 takes exactly 512 samples at 16 kHz, plus the last 64 samples of
# the previous frame as context.
FRAME_SAMPLES = 512
CONTEXT_SAMPLES = 64
FRAME_MS = FRAME_SAMPLES * 1000 // SAMPLE_RATE

# Hysteresis: a frame counts as speech above START, and as silence below STOP.
# Inside a turn, a frame above START also resets the silence count.
SPEECH_START_PROB = 0.5
SPEECH_STOP_PROB = 0.35
# Speech must last this long to open a turn, so a click or cough doesn't.
MIN_SPEECH_MS = 200
# Audio kept from before speech was confirmed, so the first syllable isn't cut.
PREROLL_MS = 500
# Silence that triggers a smart-turn check. Short, because smart-turn, not the
# VAD, decides whether the turn is over.
PAUSE_MS = 200
# Silence that ends a turn even when smart-turn keeps calling it unfinished.
MAX_SILENCE_MS = 3000
# One turn's cap, matching the push-to-talk recorder's.
MAX_TURN_MS = 60_000
# The most audio one message may carry: about 8 s, far more than the webview's
# 32 ms posts.
MAX_MESSAGE_BYTES = 256 * 1024

# Smart-turn looks at the last 8 s of a turn, the most its input takes, and
# calls the turn finished at or above the threshold.
SMART_TURN_SECONDS = 8
SMART_TURN_THRESHOLD = 0.5
# Frames that cover smart-turn's window, so a pause check copies only those.
SMART_TURN_FRAMES = SMART_TURN_SECONDS * SAMPLE_RATE // FRAME_SAMPLES + 1

# A message for the client, and the audio that follows it when there is any.
Event = tuple[dict, np.ndarray | None]


def load_session(path: str) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.inter_op_num_threads = 1
    options.intra_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(path, sess_options=options, providers=["CPUExecutionProvider"])


class Models:
    """Loaded once and shared; each connection keeps its own Silero state."""

    def __init__(self) -> None:
        self.silero = load_session(
            hf_hub_download(SILERO_REPO, SILERO_FILE, revision=SILERO_REVISION)
        )
        self.smart_turn = load_session(
            hf_hub_download(SMART_TURN_REPO, SMART_TURN_FILE, revision=SMART_TURN_REVISION)
        )
        self.features = WhisperFeatureExtractor(chunk_length=SMART_TURN_SECONDS)

    def turn_probability(self, audio: np.ndarray) -> float:
        """Smart-turn's probability that `audio` (float32, 16 kHz) ends a turn."""
        samples = SMART_TURN_SECONDS * SAMPLE_RATE
        # The model wants the speech at the end of the window, padded in front.
        audio = audio[-samples:]
        if len(audio) < samples:
            audio = np.pad(audio, (samples - len(audio), 0))
        inputs = self.features(
            audio,
            sampling_rate=SAMPLE_RATE,
            return_tensors="np",
            padding="max_length",
            max_length=samples,
            truncation=True,
            do_normalize=True,
        )
        features = inputs.input_features.astype(np.float32)
        output = self.smart_turn.run(None, {"input_features": features})
        return float(output[0].reshape(-1)[0])


class Vad:
    """Silero v5 over a stream, one 512-sample frame at a time."""

    def __init__(self, session: ort.InferenceSession) -> None:
        self.session = session
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros(CONTEXT_SAMPLES, dtype=np.float32)
        self.sr = np.array(SAMPLE_RATE, dtype=np.int64)

    def probability(self, frame: np.ndarray) -> float:
        chunk = np.concatenate([self.context, frame])[np.newaxis, :]
        output, self.state = self.session.run(
            None, {"input": chunk, "state": self.state, "sr": self.sr}
        )
        self.context = frame[-CONTEXT_SAMPLES:]
        return float(output.reshape(-1)[0])


class TurnTracker:
    """Turns a stream of frames into speech_start, pause and turn events.

    Waiting: MIN_SPEECH_MS of speech in a row opens a turn (speech_start), with
    PREROLL_MS of the audio before it. In a turn: PAUSE_MS of silence asks
    smart-turn once per pause, which either ends the turn ("complete") or
    reports a pause. MAX_SILENCE_MS of silence or MAX_TURN_MS of turn ends it
    regardless. In a turn, a frame between SPEECH_STOP_PROB and
    SPEECH_START_PROB neither adds to the silence nor resets it.
    """

    def __init__(self, models: Models) -> None:
        self.models = models
        self.vad = Vad(models.silero)
        # What is left over between messages: samples short of a whole frame,
        # and a byte short of a whole sample.
        self.pending = np.zeros(0, dtype=np.float32)
        self.odd_byte = b""
        self.reset_turn()

    def reset_turn(self) -> None:
        """Waits for the next turn. The stream and the VAD's state carry on."""
        self.preroll: deque[np.ndarray] = deque(maxlen=PREROLL_MS // FRAME_MS)
        self.speech_ms = 0
        self.in_turn = False
        self.turn: list[np.ndarray] = []
        self.turn_ms = 0
        self.silence_ms = 0
        # Set once smart-turn has been asked about the current pause, so it
        # isn't asked again until the user speaks.
        self.checked_pause = False

    def push_pcm(self, pcm: bytes) -> list[Event]:
        pcm = self.odd_byte + pcm
        whole = len(pcm) - len(pcm) % 2
        self.odd_byte = pcm[whole:]
        samples = np.frombuffer(pcm[:whole], dtype="<i2").astype(np.float32) / 32768.0
        self.pending = np.concatenate([self.pending, samples])
        events: list[Event] = []
        while len(self.pending) >= FRAME_SAMPLES:
            frame = self.pending[:FRAME_SAMPLES]
            self.pending = self.pending[FRAME_SAMPLES:]
            event = self.process_frame(frame)
            if event:
                events.append(event)
        return events

    def process_frame(self, frame: np.ndarray) -> Event | None:
        speech_probability = self.vad.probability(frame)

        if not self.in_turn:
            self.preroll.append(frame)
            if speech_probability >= SPEECH_START_PROB:
                self.speech_ms += FRAME_MS
            else:
                self.speech_ms = 0
            if self.speech_ms < MIN_SPEECH_MS:
                return None
            self.in_turn = True
            self.turn = list(self.preroll)
            self.turn_ms = len(self.turn) * FRAME_MS
            self.silence_ms = 0
            return {"type": "speech_start"}, None

        self.turn.append(frame)
        self.turn_ms += FRAME_MS
        if speech_probability >= SPEECH_START_PROB:
            self.silence_ms = 0
            self.checked_pause = False
        elif speech_probability < SPEECH_STOP_PROB:
            self.silence_ms += FRAME_MS

        if self.turn_ms >= MAX_TURN_MS:
            return self.finish("cap", None)
        if self.silence_ms >= MAX_SILENCE_MS:
            return self.finish("silence", None)
        if self.silence_ms >= PAUSE_MS and not self.checked_pause:
            self.checked_pause = True
            recent = np.concatenate(self.turn[-SMART_TURN_FRAMES:])
            end_probability = self.models.turn_probability(recent)
            if end_probability >= SMART_TURN_THRESHOLD:
                return self.finish("complete", end_probability)
            return {"type": "pause", "probability": end_probability}, None
        return None

    def finish(self, reason: str, probability: float | None) -> Event:
        audio = np.concatenate(self.turn)
        self.reset_turn()
        return {"type": "turn", "reason": reason, "probability": probability}, audio


def token_matches(path: str, token: str) -> bool:
    """Whether a request path carries `?token=` equal to `token`, compared in constant time."""
    given = parse_qs(urlparse(path).query).get("token", [""])[0]
    return hmac.compare_digest(given.encode(), token.encode())


def to_pcm(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


async def main() -> None:
    token = os.environ.get("YARVIS_TURN_TOKEN", "")
    if not token:
        sys.exit("YARVIS_TURN_TOKEN is not set")

    models = Models()

    def authorize(connection: ServerConnection, request: Request) -> Response | None:
        if not token_matches(request.path, token):
            return connection.respond(401, "bad token\n")
        return None

    async def handle(connection: ServerConnection) -> None:
        tracker = TurnTracker(models)
        async for message in connection:
            if isinstance(message, str):
                continue
            # Inference runs off the event loop so other connections keep up.
            events = await asyncio.to_thread(tracker.push_pcm, message)
            for event, audio in events:
                await connection.send(json.dumps(event))
                if audio is not None:
                    await connection.send(to_pcm(audio))

    # Loopback only; port 0 lets the OS pick, so instances never collide.
    async with serve(
        handle, "127.0.0.1", 0, process_request=authorize, max_size=MAX_MESSAGE_BYTES
    ) as server:
        port = server.sockets[0].getsockname()[1]
        print(f"YARVIS_TURN_READY {port}", flush=True)
        await asyncio.get_running_loop().run_in_executor(None, sys.stdin.read)


if __name__ == "__main__":
    asyncio.run(main())
