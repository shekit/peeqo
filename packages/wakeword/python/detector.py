#!/usr/bin/env python3
"""Peeqo's wake word and voice-activity detector, run by the Node side (src/index.ts) as a helper process.

Reads 16 kHz, 16-bit, mono PCM from stdin and writes one JSON object per line to stdout:

  {"type": "ready", "words": ["hey_jarvis"]}
  {"type": "vad", "speech": 0.83}                      every 80 ms: how likely it is that someone is speaking
  {"type": "wake", "word": "hey_jarvis", "score": 0.99}

The wake word is microWakeWord's (pymicro-wakeword): a streaming model made for microcontrollers, fed every 10 ms. It
fires within about a tenth of a second of the wake word ending, using about 6% of a Raspberry Pi 3 B+ core, so it
runs all the time. Each model brings its own cut-off (in its JSON), and its score is averaged over a few steps, so a
look-alike phrase that spikes for a moment does not fire. After a wake the detector rests for a moment, so one
utterance gives one wake.

Speech is pymicro-vad's. It only runs while there is sound: a loudness check (a fraction of a millisecond) listens
first, a chunk about 10 dB louder than the room's background (which it keeps track of) starts it, and two seconds of
quiet stop it. In a quiet room the speech score is 0. Everything is on the device; nothing is downloaded here.
"""
import argparse
import json
import os
import sys

import numpy as np
from pymicro_vad import MicroVad
from pymicro_wakeword import MicroWakeWord, MicroWakeWordFeatures, Model

CHUNK = 1280  # samples: 80 ms at 16 kHz, one speech score each
STEP = 160  # samples: 10 ms, what the models take
QUIET_AFTER = 25  # chunks (2 s) of quiet before the voice detector stops
LOUDER_THAN_ROOM = 3.0  # sound: about 10 dB over the room's background
MIN_LOUD = 60.0  # and never quieter than this (RMS of 16-bit samples, about -55 dBFS)
BUILT_IN = {model.name.lower(): model for model in Model}  # okay_nabu, hey_jarvis, hey_mycroft, alexa


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def load(word):
    """A wake word's model: a built-in name, or a microWakeWord model's .json (with its .tflite beside it)."""
    if word in BUILT_IN:
        return word, MicroWakeWord.from_builtin(BUILT_IN[word])
    if word.endswith(".json") and os.path.exists(word):
        return os.path.splitext(os.path.basename(word))[0], MicroWakeWord.from_config(word)
    raise ValueError(f'no wake word "{word}" (built in: {", ".join(BUILT_IN)}; or a model .json file)')


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--word", action="append", help="wake word: a built-in name (hey_jarvis, okay_nabu, hey_mycroft, alexa) or a microWakeWord model .json; repeatable")
    parser.add_argument("--rest", type=float, default=2.0, help="seconds without wakes after one fires")
    args = parser.parse_args()
    try:
        detectors = [load(word) for word in (args.word or ["hey_jarvis"])]
        features = MicroWakeWordFeatures()
        vad = MicroVad()
    except Exception as error:  # missing packages or models: say so plainly and stop
        send({"type": "error", "message": f"could not load the wake word models ({error}); run the setup first"})
        return 1
    send({"type": "ready", "words": [name for name, _ in detectors]})

    stdin = sys.stdin.buffer
    resting = 0  # 10 ms steps left without wakes
    background = None  # the room's loudness: drops at once to anything quieter, creeps up over about 40 s
    quiet = QUIET_AFTER + 1
    hearing = False  # whether the voice detector is running
    while True:
        data = stdin.read(CHUNK * 2)
        if len(data) < CHUNK * 2:
            return 0  # stdin closed: the Node side stopped us
        samples = np.frombuffer(data, dtype=np.int16).astype(np.float32)
        loudness = float(np.sqrt(np.mean(samples * samples)))
        if background is None or loudness < background:
            background = loudness
        else:
            background += (loudness - background) * 0.002
        quiet = 0 if loudness > max(MIN_LOUD, background * LOUDER_THAN_ROOM) else quiet + 1
        if quiet <= QUIET_AFTER and not hearing:
            vad.reset()
        hearing = quiet <= QUIET_AFTER
        speech = 0.0
        for start in range(0, len(data), STEP * 2):
            step = data[start : start + STEP * 2]
            if hearing:
                speech = max(speech, min(1.0, max(0.0, float(vad.process_10ms(step)))))
            for feature in features.process_streaming(step):
                # Every model sees every feature (each keeps its own window), resting or not.
                for name, detector in detectors:
                    score = detector.process_streaming_prob(feature)
                    if score is not None and score > detector.probability_cutoff and resting == 0:
                        send({"type": "wake", "word": name, "score": round(float(score), 3)})
                        resting = int(args.rest * 1000 / 10)
            if resting > 0:
                resting -= 1
        send({"type": "vad", "speech": round(speech, 3)})


if __name__ == "__main__":
    sys.exit(main())
