# @peeqo/wakeword

Wake word and speech detection for Peeqo, using [microWakeWord](https://github.com/OHF-Voice/micro-wake-word)
([pymicro-wakeword](https://pypi.org/project/pymicro-wakeword/)) and its voice-activity detector
([pymicro-vad](https://pypi.org/project/pymicro-vad/)). It runs entirely on the device, with no account or key, so
nothing is sent anywhere until the wake word is heard.

```sh
npm run setup -w @peeqo/wakeword     # a Python environment in .venv (again only when the requirements change)
```

Setup needs Python 3.9 or newer, and uses [uv](https://docs.astral.sh/uv/) when it is installed. The models come
with the packages: nothing is downloaded at run time.

- **How Node uses it:** `WakeWordDetector` starts `python/detector.py` as a helper process.
  - Node writes 16 kHz, 16-bit mono audio to the helper's stdin.
  - The helper answers with one JSON event per line on stdout: `ready`, `vad` (how likely it is that someone is
    speaking, every 80 ms), `wake` and `error`.
- **Wake words:** the default is `hey_jarvis`; `okay_nabu`, `hey_mycroft` and `alexa` are built in too. A custom
  "hey Peeqo" needs a trained microWakeWord model (its trainer makes the examples with a text-to-speech voice, so no
  recordings are needed); pass its `.json` as a word.
- **Speed:** the wake word model is fed every 10 ms and fires within about a tenth of a second of the wake word
  ending, using about 6% of a Raspberry Pi 3 B+ core. The voice-activity detector only runs while there is sound.
- **False wakes:** each model's score is averaged over a few steps and must pass its own cut-off (0.97 for
  `hey_jarvis`), so look-alike phrases that spike for a moment don't fire.
- **Tests:** the detection tests speak with macOS `say`, so they're skipped elsewhere and before setup.
