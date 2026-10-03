#!/usr/bin/env python3
"""Peeqo's wake word and voice-activity detector, run by the Node side (src/index.ts) as a helper process.

Reads 16 kHz, 16-bit, mono PCM from stdin and writes one JSON object per line to stdout:

  {"type": "ready", "words": ["hey_jarvis"]}
  {"type": "vad", "speech": 0.83}                      every 80 ms: how likely it is that someone is speaking
  {"type": "wake", "word": "hey_jarvis", "score": 0.99}

A wake word fires once its score has stayed above the threshold for `patience` chunks (80 ms each) in a row: real
wake words hold for many chunks, while look-alike phrases spike for one. After a wake the detector rests for a
moment, so one utterance gives one wake. Models come from openWakeWord (see setup.mjs); nothing is downloaded here.
"""
import argparse
import json
import os
import sys

import numpy as np
from openwakeword.model import Model
from openwakeword.vad import VAD

CHUNK = 1280  # samples: 80 ms at 16 kHz, what openWakeWord expects


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
    while True:
        data = stdin.read(CHUNK * 2)
        if len(data) < CHUNK * 2:
            return 0  # stdin closed: the Node side stopped us
        audio = np.frombuffer(data, dtype=np.int16)
        send({"type": "vad", "speech": round(float(vad.predict(audio, frame_size=640)), 3)})
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
