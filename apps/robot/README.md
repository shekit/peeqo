# Peeqo on the robot

The service that runs Peeqo on its Raspberry Pi. It runs the same brain, character, animation and safety governor as
the simulator, and drives:

- the real servos;
- the LED ring;
- the face screen;
- the speaker and microphone;
- the buttons.

It also serves a web panel to phones and laptops on the same Wi-Fi, and a setup page for joining a new Wi-Fi network.

## Try it on a laptop

```sh
npm run robot                         # fake hardware: http://localhost:8080 (panel), /face (the screen)
npm run dev -w @peeqo/robot -- --setup   # start as if no Wi-Fi were known, to try the setup page
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

1. **Which arm is which:** each channel wiggles its arm by about 1°, and you click the arm that moved.
2. **Each arm:**
   - Press + once and say whether the arm went up or down.
   - Nudge it until it points level. It can't be moved far below where it started, because the arms rest close to
     their holders.
3. **Level:** Peeqo rises to its normal height. Put your phone flat on its head with a level app open and tap until
   it reads 0°.
4. **Check:** Peeqo tilts back 3°. Type what the level reads; this corrects the scale.

Every calibration move is slow and starts from 1500 µs, where the 2019 software always left the servos. The servo
driver is set up exactly as the 2019 one was, so 1500 µs means the same thing.

After calibration, the motion governor drives the servos. On the robot, it keeps every horn between 5° and 55°,
leaving room for calibration error.

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
- **Microphone and speaker:** the default ALSA devices. Pick others with `--mic` and `--speaker` in
  `/etc/systemd/system/peeqo.service` (see `arecord -L` and `aplay -L`).
- **Hardware access:** the hardware helper (`python/hardware.py`) drives the servo board (PCA9685, I²C bus 1, 0x40),
  the LED ring (12 APA102 LEDs on SPI 0.0, 4 MHz) and the buttons (GPIO 4, 16, 17 and 23, high when pressed), all as
  wired in 2019.

## Still to check on the real robot

These can't be checked without the hardware:

- the screen's resolution and rotation;
- which ALSA devices are the mic and the speaker, and their levels;
- where LED 0 sits on the ring;
- which physical button is which GPIO (the panel's log shows each press);
- the setup network and captive portal on real phones;
- the calibration itself.
