#!/usr/bin/env python3
"""Peeqo's wake word and voice-activity detector, run by the Node side (src/index.ts) as a helper process.

Reads 16 kHz, 16-bit, mono PCM from stdin and writes one JSON object per line to stdout:

  {"type": "ready", "words": ["hey_jarvis"]}
  {"type": "vad", "speech": 0.83}                      every 80 ms: how likely it is that someone is speaking
  {"type": "wake", "word": "hey_jarvis", "score": 0.99}

A wake word fires once its score has stayed above the threshold for `patience` chunks (80 ms each) in a row: real
wake words hold for many chunks, while look-alike phrases spike for one. After a wake the detector rests for a
moment, so one utterance gives one wake. Models come from openWakeWord (see setup.mjs); nothing is downloaded here.

The models only run while there is sound. On a Raspberry Pi 3 B+ the wake word model takes about 68 ms of each 80 ms
chunk and the voice detector 14 ms: run all the time, they would fill a core, heat the Pi up and fall behind. So a
loudness check (a fraction of a millisecond) listens first. Once a chunk is about 10 dB louder than the room's
background (which it keeps track of), the models start, catching up on the last 0.64 s so a wake word is heard from
its first sound, and run until the room has been quiet for two seconds. While they run, the voice detector looks at
every fourth chunk. In a quiet room the speech score is 0.
"""
import argparse
import json
import os
import sys
from collections import deque

import types

import numpy as np

# openwakeword/__init__.py imports its training helper (scikit-learn and scipy) only to export it. Nothing here
# trains, and leaving them out saves about 90 MB, which matters on a 1 GB Pi 3 B+.
_stub = types.ModuleType("openwakeword.custom_verifier_model")
_stub.train_custom_verifier = None
sys.modules.setdefault("openwakeword.custom_verifier_model", _stub)

from openwakeword.model import Model  # noqa: E402 (after the stub, on purpose)
from openwakeword.vad import VAD  # noqa: E402

CHUNK = 1280  # samples: 80 ms at 16 kHz, what openWakeWord expects
QUIET_AFTER = 25  # chunks (2 s) of quiet before the models stop
CATCH_UP = 8  # chunks (0.64 s) from before the sound started, run when the models start
VAD_EVERY = 4  # while listening, the voice detector runs on every fourth chunk
LOUDER_THAN_ROOM = 3.0  # sound: about 10 dB over the room's background
MIN_LOUD = 60.0  # and never quieter than this (RMS of 16-bit samples, about -55 dBFS)


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--word", action="append", help="wake word: a pre-trained name (e.g. hey_jarvis) or a model file; repeatable")
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--patience", type=int, default=3, help="chunks in a row above the threshold")
    parser.add_argument("--rest", type=float, default=2.0, help="seconds without wakes after one fires")
    args = parser.parse_args()
    words = args.word or ["hey_jarvis"]
    try:
        model = Model(wakeword_models=words, inference_framework="onnx")
        vad = VAD()
    except Exception as error:  # missing models or packages: say so plainly and stop
        send({"type": "error", "message": f"could not load the wake word models ({error}); run the setup first"})
        return 1
    names = list(model.models.keys())
    send({"type": "ready", "words": names})

    runs = {name: 0 for name in names}
    resting = 0
    stdin = sys.stdin.buffer
    background = None  # the room's loudness: drops at once to anything quieter, creeps up over about 40 s
    recent = deque(maxlen=CATCH_UP)
    listening = False
    quiet = 0
    count = 0
    speech = 0.0
    while True:
        data = stdin.read(CHUNK * 2)
        if len(data) < CHUNK * 2:
            return 0  # stdin closed: the Node side stopped us
        audio = np.frombuffer(data, dtype=np.int16)
        samples = audio.astype(np.float32)
        loudness = float(np.sqrt(np.mean(samples * samples)))
        if background is None or loudness < background:
            background = loudness
        else:
            background += (loudness - background) * 0.002
        loud = loudness > max(MIN_LOUD, background * LOUDER_THAN_ROOM)
        quiet = 0 if loud else quiet + 1
        if not listening:
            if not loud:
                recent.append(audio)
                send({"type": "vad", "speech": 0.0})
                continue
            listening = True
            model.reset()
            for earlier in recent:
                model.predict(earlier)
            recent.clear()
        elif quiet > QUIET_AFTER:
            listening = False
            runs = {n: 0 for n in names}
            speech = 0.0
            recent.append(audio)
            send({"type": "vad", "speech": 0.0})
            continue
        if count % VAD_EVERY == 0:
            speech = round(float(vad.predict(audio, frame_size=640)), 3)
        count += 1
        send({"type": "vad", "speech": speech})
        scores = model.predict(audio)
        if resting > 0:
            resting -= 1
            continue
        for name, score in scores.items():
            runs[name] = runs[name] + 1 if score > args.threshold else 0
            if runs[name] >= args.patience:
                send({"type": "wake", "word": name, "score": round(float(score), 3)})
                runs = {n: 0 for n in names}
                resting = int(args.rest * 16000 / CHUNK)
                model.reset()
                break


if __name__ == "__main__":
    sys.exit(main())
