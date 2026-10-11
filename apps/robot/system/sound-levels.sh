#!/usr/bin/env bash
# Sets the board's sound chip (WM8960) up for Peeqo, once: the speaker on and loud enough, the microphones on.
# Run by install.sh once the chip is there; after that the levels are left as they are (alsactl keeps them).
set -uo pipefail
MARK=/var/lib/peeqo/sound-levels
[ -f "$MARK" ] && exit 0
CARD=wm8960soundcard
set_control() { amixer -q -c "$CARD" sset "$1" "${@:2}" 2>/dev/null || echo "(no control \"$1\" on the sound chip)"; }

# Playing: the DAC into both output mixers, out through the speaker (class D) and headphone outputs.
set_control 'Left Output Mixer PCM' on
set_control 'Right Output Mixer PCM' on
set_control 'Playback' 255
set_control 'Speaker' 115
set_control 'Speaker AC' 4
set_control 'Speaker DC' 4
set_control 'Headphone' 100

# Recording: both microphones (LINPUT1 and RINPUT1) through the boost mixers into the ADC.
set_control 'Left Boost Mixer LINPUT1' on
set_control 'Right Boost Mixer RINPUT1' on
set_control 'Left Input Mixer Boost' on
set_control 'Right Input Mixer Boost' on
set_control 'Left Input Boost Mixer LINPUT1' 2
set_control 'Right Input Boost Mixer RINPUT1' 2
set_control 'Capture' 45 cap
set_control 'ADC PCM' 195

sudo alsactl store "$CARD"
sudo install -d /var/lib/peeqo
sudo touch "$MARK"
echo "sound levels set"
