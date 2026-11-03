# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy==2.5.4"]
#
# [tool.uv]
# exclude-newer = "2026-11-01T00:00:00Z"
# ///
"""Tests for turn_server.py's turn logic and token check.

Run with `bun run voice:test-turns`. The model libraries are stubbed, so this
needs only numpy: Silero's speech probabilities and smart-turn's verdicts are
scripted per test instead of computed from real audio.
"""

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock

import numpy as np

for name in [
    "onnxruntime",
    "huggingface_hub",
    "transformers",
    "websockets",
    "websockets.asyncio",
    "websockets.asyncio.server",
    "websockets.http11",
]:
    sys.modules.setdefault(name, MagicMock())

_spec = importlib.util.spec_from_file_location(
    "turn_server", Path(__file__).with_name("turn_server.py")
)
assert _spec and _spec.loader
ts = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ts)

SPEECH = 0.9
SILENCE = 0.1
# Between the stop and start thresholds: neither speech nor silence.
UNSURE = 0.4

PAUSE_FRAMES = -(-ts.PAUSE_MS // ts.FRAME_MS)
MIN_SPEECH_FRAMES = -(-ts.MIN_SPEECH_MS // ts.FRAME_MS)
PREROLL_FRAMES = ts.PREROLL_MS // ts.FRAME_MS


class FakeSilero:
    """Answers each frame with the next scripted speech probability."""

    def __init__(self) -> None:
        self.probabilities: list[float] = []

    def run(self, _outputs, inputs):
        probability = self.probabilities.pop(0)
        return [np.array([[probability]], dtype=np.float32), inputs["state"]]


class FakeModels:
    def __init__(self, verdicts: list[float] | None = None) -> None:
        self.silero = FakeSilero()
        self.verdicts = list(verdicts or [])
        self.asked: list[int] = []

    def turn_probability(self, audio: np.ndarray) -> float:
        self.asked.append(len(audio))
        return self.verdicts.pop(0)


def frame_bytes(value: int) -> bytes:
    return np.full(ts.FRAME_SAMPLES, value, dtype="<i2").tobytes()


def feed(tracker, models: FakeModels, probabilities: list[float], value: int = 1000):
    """Pushes one frame per probability and returns the events, without their audio."""
    models.silero.probabilities.extend(probabilities)
    events = []
    for _ in probabilities:
        events.extend(tracker.push_pcm(frame_bytes(value)))
    return events


def types(events) -> list[str]:
    return [event["type"] for event, _audio in events]


class TurnTrackerTest(unittest.TestCase):
    def test_silence_produces_nothing(self):
        models = FakeModels()
        tracker = ts.TurnTracker(models)
        self.assertEqual(feed(tracker, models, [SILENCE] * 50), [])

    def test_a_click_too_short_to_be_speech_opens_no_turn(self):
        models = FakeModels()
        tracker = ts.TurnTracker(models)
        events = feed(tracker, models, [SPEECH] * (MIN_SPEECH_FRAMES - 1) + [SILENCE] * 20)
        self.assertEqual(events, [])

    def test_speech_opens_a_turn_once_it_lasts(self):
        models = FakeModels()
        tracker = ts.TurnTracker(models)
        events = feed(tracker, models, [SPEECH] * MIN_SPEECH_FRAMES)
        self.assertEqual(types(events), ["speech_start"])

    def test_a_finished_turn_comes_back_with_its_preroll(self):
        models = FakeModels(verdicts=[0.9])
        tracker = ts.TurnTracker(models)
        feed(tracker, models, [SILENCE] * 30, value=7)
        events = feed(tracker, models, [SPEECH] * 20 + [SILENCE] * PAUSE_FRAMES, value=1000)

        self.assertEqual(types(events), ["speech_start", "turn"])
        event, audio = events[-1]
        self.assertEqual(event["reason"], "complete")
        self.assertAlmostEqual(event["probability"], 0.9)
        # The silence before speech was confirmed is kept, so the first
        # syllable isn't cut.
        self.assertAlmostEqual(float(audio[0]), 7 / 32768, places=6)
        expected_frames = PREROLL_FRAMES + (20 - MIN_SPEECH_FRAMES) + PAUSE_FRAMES
        self.assertEqual(len(audio), expected_frames * ts.FRAME_SAMPLES)

    def test_asks_smart_turn_once_per_pause_and_again_after_more_speech(self):
        models = FakeModels(verdicts=[0.1, 0.8])
        tracker = ts.TurnTracker(models)
        first = feed(tracker, models, [SPEECH] * 10 + [SILENCE] * (PAUSE_FRAMES + 20))
        self.assertEqual(types(first), ["speech_start", "pause"])
        self.assertEqual(len(models.asked), 1)

        second = feed(tracker, models, [SPEECH] * 3 + [SILENCE] * PAUSE_FRAMES)
        self.assertEqual(types(second), ["turn"])
        self.assertEqual(second[0][0]["reason"], "complete")

    def test_ends_on_long_silence_when_smart_turn_keeps_waiting(self):
        models = FakeModels(verdicts=[0.1])
        tracker = ts.TurnTracker(models)
        silence_frames = -(-ts.MAX_SILENCE_MS // ts.FRAME_MS)
        events = feed(tracker, models, [SPEECH] * 10 + [SILENCE] * silence_frames)
        self.assertEqual(types(events), ["speech_start", "pause", "turn"])
        self.assertEqual(events[-1][0], {"type": "turn", "reason": "silence", "probability": None})

    def test_unsure_frames_neither_add_silence_nor_reset_it(self):
        models = FakeModels(verdicts=[0.9])
        tracker = ts.TurnTracker(models)
        events = feed(
            tracker,
            models,
            [SPEECH] * 10 + [SILENCE] * (PAUSE_FRAMES - 1) + [UNSURE] * 30 + [SILENCE],
        )
        self.assertEqual(types(events), ["speech_start", "turn"])

    def test_caps_a_turn_that_never_pauses(self):
        models = FakeModels()
        tracker = ts.TurnTracker(models)
        cap_frames = -(-ts.MAX_TURN_MS // ts.FRAME_MS)
        events = feed(tracker, models, [SPEECH] * (cap_frames + 5))
        self.assertEqual(types(events), ["speech_start", "turn"])
        self.assertEqual(events[-1][0]["reason"], "cap")
        self.assertEqual(models.asked, [])

    def test_only_smart_turns_window_is_copied_for_a_check(self):
        models = FakeModels(verdicts=[0.9])
        tracker = ts.TurnTracker(models)
        feed(tracker, models, [SPEECH] * 400 + [SILENCE] * PAUSE_FRAMES)
        self.assertEqual(models.asked, [ts.SMART_TURN_FRAMES * ts.FRAME_SAMPLES])

    def test_audio_split_mid_sample_across_messages_comes_back_whole(self):
        models = FakeModels(verdicts=[0.9])
        tracker = ts.TurnTracker(models)
        frames = 10 + PAUSE_FRAMES
        models.silero.probabilities.extend([SPEECH] * 10 + [SILENCE] * PAUSE_FRAMES)
        samples = np.arange(frames * ts.FRAME_SAMPLES, dtype="<i2")
        pcm = samples.tobytes()
        events = []
        # An odd split leaves half a sample behind in each message.
        for start in range(0, len(pcm), 333):
            events.extend(tracker.push_pcm(pcm[start : start + 333]))

        self.assertEqual(types(events), ["speech_start", "turn"])
        np.testing.assert_array_equal(events[-1][1], samples.astype(np.float32) / 32768.0)


class TokenTest(unittest.TestCase):
    def test_accepts_the_right_token(self):
        self.assertTrue(ts.token_matches("/?token=abc", "abc"))

    def test_refuses_a_wrong_or_missing_token(self):
        self.assertFalse(ts.token_matches("/?token=abd", "abc"))
        self.assertFalse(ts.token_matches("/", "abc"))
        self.assertFalse(ts.token_matches("/?token=", "abc"))


if __name__ == "__main__":
    unittest.main()
