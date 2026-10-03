# @peeqo/wakeword

Wake word and speech detection for Peeqo, using [openWakeWord](https://github.com/dscripka/openWakeWord). It runs
on the device, so nothing is sent anywhere until the wake word is heard.

```sh
npm run setup -w @peeqo/wakeword     # once: a Python environment in .venv, and the models
```

Setup needs Python 3.10 or newer, and uses [uv](https://docs.astral.sh/uv/) when it is installed.

- **How Node uses it:** `WakeWordDetector` starts `python/detector.py` as a helper process.
  - Node writes 16 kHz, 16-bit mono audio to the helper's stdin.
  - The helper answers with one JSON event per line on stdout: `ready`, `vad` (how likely it is that someone is
    speaking, every 80 ms), `wake` and `error`.
- **Wake words:** the default is `hey_jarvis`, a ready-made model. A custom "hey Peeqo" needs training a model
  (openWakeWord's training notebook), then passing its file as a word.
- **False wakes:** a wake fires only after the score stays above 0.5 for three 80 ms chunks in a row. Real wake
  words hold for seven or eight; look-alike phrases spike for one.
- **Tests:** the detection tests speak with macOS `say`, so they're skipped elsewhere and before setup.
