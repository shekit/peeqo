# Peeqo on the robot

The service that runs Peeqo on its Raspberry Pi. It runs the same brain, character, animation and safety governor as
the simulator, and drives:

- the real servos;
- the LED ring;
- the face screen;
- the speaker and microphone;
- the buttons.

It also serves a web panel to phones and laptops on the same Wi-Fi, and a setup page for joining a new Wi-Fi network.

It runs on the dev kit's Raspberry Pi 3 B+ (1 GB), and on later models.

## Try it on a laptop

```sh
npm run robot                         # fake hardware: http://localhost:8080 (panel), /face (the screen)
npm run dev -w @peeqo/robot -- --setup   # start as if no Wi-Fi were known, to try the setup page
npm run verify:robot                  # drives the pages in Chrome: setup, sign-in, talking, calibration, buttons
```

Run `npm run build -w @peeqo/robot` first to build the pages. With fake hardware, nothing is driven: the servo board
and LEDs pretend, the Wi-Fi networks are made up, and the panel has pretend buttons.

## Put it on the robot

1. **SD card:** in Raspberry Pi Imager, choose Raspberry Pi OS Lite (64-bit). In its settings, set:
   - the hostname `peeqo`;
   - a user and password;
   - SSH on;
   - your Wi-Fi (optional: without it, Peeqo starts its setup network).
2. **Boot the Pi in Peeqo, then deploy from this computer:**

   ```sh
   npm run deploy -w @peeqo/robot              # to pi@peeqo.local; add -- user@host for another address
   ```

   This copies the software to `~/peeqo` and runs `apps/robot/install.sh` there. The first run installs Node 22,
   Chromium and the Python parts, turns on I²C and SPI, and sets up the wake word, which takes about 15 minutes.
   After that, each deploy only updates and restarts.
3. **Open `http://peeqo.local`.** The first time, it asks for a PIN for the panel. Add the OpenRouter and Klipy keys
   in Settings.
4. **Calibrate** from the panel. Peeqo's servos stay limp until this is done. See below.

## Setting up Wi-Fi, for anyone

If Peeqo knows no Wi-Fi network, it starts its own network, "Peeqo-Setup-XXXX", and shows a QR code on its face.

- **Phone:** scan the QR code with the camera. The phone joins the network and opens the setup page.
- **Laptop:** join the network shown on the screen, then open `http://10.42.0.1`.

On the page, choose your Wi-Fi, a PIN for the panel and, optionally, the API keys. Peeqo joins your network and shows
its address. If the password was wrong, the setup network comes back and both the page and the face say why.

Hold a button for 10 s to do this again, for example after moving house.

## Buttons

| Press | Does |
| --- | --- |
| Tap | Talk: Peeqo listens, as after its wake word |
| 1–3 s | Shows Peeqo's address (or how to set it up) |
| Hold 3 s, then let go | Shuts down (as the 2019 rear button did) |
| Hold 10 s | Setup mode (join another Wi-Fi network) |

A button only counts once it has been seen released, so a button stuck down at start-up does nothing.

## Calibration

Calibration is done once, from the panel, with the cloth cover off so the three servo arms are visible. It takes
about 10 minutes.

1. **Which arm is which, and which way it turns:** for each plug on the servo board, tap ▲ (about 1° a tap) until you
   see an arm move, then say which arm it was and whether it went up or down. The arms are short, so it takes a few
   taps to see.
2. **Level each arm:** nudge it until it points level. An arm only moves a little on its own: the arms are linked
   through the head, so one arm alone tilts it.
3. **Range, all together:** the whole head moves up and down, staying level. Each ▲/▼ moves all three arms by
   0.5°.
   - **Lowest:** lower it until something is just about to touch, then mark it.
   - **Highest:** raise it until it's as high as it should go, just short of binding, then mark it. It must leave
     room for Peeqo's normal height.

   Each servo's pulses at those two points become its range.
4. **Level:** Peeqo goes to its normal height, arms level (1500 µs). Put your phone flat on its head with a level app
   open and tap until it reads 0° (optional).
5. **Check:** Peeqo tilts back 3°. Type what the level reads; this corrects the scale (optional).
6. **Save.**

You set the limits: calibration has none of its own, only the servos' travel (500–2500 µs). Every move is a small,
slow step you ask for, so stop before anything touches. It starts from 1500 µs, where the 2019 software always left
the servos. The servo driver is set up exactly as the 2019 one was, so 1500 µs means the same thing.

After calibration, the motion governor drives the servos. Peeqo stands with its arms level, its head moves are sized
to fill the room your marks leave (they were written for the 3D model's smaller room: on the dev kit they play about
2.5 times as big, keeping a tenth of the room spare), and your marks are its only limits on where the arms go:
- **The governor plans inside them,** 1.5° in from each mark. Beyond that it only keeps to the neck's geometry (no leg
  pulled straight), a box on tilts, and its speed caps. It doesn't use the 3D model's collision tables on the robot:
  they put the arms' holders just below level, but the dev kit's arms move freely about 85° either way.
- **The servo driver never sends a pulse outside them.** If anything ever asked it to, it holds still instead.

## On the robot

- **Data, in `~/.peeqo`:**
  - `config.json`: keys, the hashed PIN and the calibration; readable only by Peeqo's user;
  - `memory.md`;
  - `conversation.json`;
  - `alarms.json`;
  - `sessions.json`.
- **Services:**
  - `peeqo` runs the service on port 80;
  - `peeqo-face` runs Chromium full screen on the display, showing `/face`.
  - Logs: `journalctl -u peeqo -f`.
- **The 3 B+'s 1 GB:**
  - The face draws at 30 frames a second.
  - Chromium runs in its low-memory mode.
  - The installer adds compressed swap if there's none.
  - The wake word detector (microWakeWord) uses about 6% of one core and the speech detector only runs while there
    is sound.
  - Measured on a Mac: the service uses about 130 MB, and its motion loop under 3% of one Pi core.
  - The face screen is the part to watch on the real board.
- **Microphone and speaker:** the board's WM8960 sound chip. The installer turns it on (`dtoverlay=wm8960-soundcard`;
  restart the robot after the first install), makes it the default for playing and recording (`/etc/asound.conf`:
  48 kHz, shared, so sounds play while the microphone listens), and sets its levels once
  (`system/sound-levels.sh`; change them with `alsamixer -c wm8960soundcard`). Pick other devices with `--mic` and
  `--speaker` in `/etc/systemd/system/peeqo.service` (see `arecord -L` and `aplay -L`).
- **Face screen:** no mouse pointer. The HDMI port's CEC remote passes for one, so a udev rule has libinput ignore it
  (`system/hdmi-cec.rules`).
- **Wi-Fi:** power saving off (it makes the Pi drop off the network), and a watchdog: if the router stops answering
  for 2 minutes, Peeqo turns its Wi-Fi off and on again.
- **Log:** kept across restarts (`journalctl -u peeqo -b -1` shows the last boot's), capped at 64 MB.
- **Heat and power:** the panel shows the Pi's temperature, and the log says when it slows down to keep cool or the
  supply dips too low (`vcgencmd get_throttled`).
- **Shutting down:** if the system has not stopped Peeqo 30 s after being asked, it forces it; if even that fails,
  the face says it is safe to unplug.
- **Hardware access:** the hardware helper (`python/hardware.py`) drives the servo board (PCA9685, I²C bus 1, 0x40),
  the LED ring (12 APA102 LEDs on SPI 0.0, 4 MHz) and the buttons (GPIO 4, 16, 17 and 23, high when pressed), all as
  wired in 2019.

## Still to check on the real robot

These can't be checked without the hardware:

- the screen's resolution and rotation;
- the speaker and microphone levels, and the wake word, by ear;
- where LED 0 sits on the ring;
- which physical button is which GPIO (the panel's log shows each press);
- the setup network and captive portal on real phones;
- the calibration itself.
