# Peeqo, next generation

The 2019 Electron app (`electron/`) is left as it was. The new software lives in a TypeScript workspace beside it,
and is developed against a simulator first. The same code will run on the robot.

```sh
npm install                          # once
npm run setup -w @peeqo/wakeword     # once, for the wake word (Python 3.10 or newer)
npm run sim                          # the simulator, at http://localhost:5173
npm run robot                        # the robot's service with fake hardware, at http://localhost:8080
npm run check                        # typecheck, unit tests, production build
npm run verify:sim                   # drives the built simulator in Chrome
```

## Packages

| Package | What it is |
| --- | --- |
| `packages/core` | Neck kinematics, the safety governor, CAD collision tables, head animation, LED patterns. No DOM or Node APIs. |
| `packages/face` | The screen face: expressive eyes (and the 2019 eyes), drawn on a canvas. |
| `packages/character` | Peeqo as a character: states, expressions, synthesized sounds, and its life between conversations. |
| `packages/brain` | The mind: OpenRouter model, Klipy GIFs, persona, conversation loop, memory (`memory.md`, kept by the model), tools (time, timers, reminders, weather), and an offline stand-in. Peeqo answers with GIFs and captions; a voice is optional. |
| `packages/wakeword` | Wake word and speech detection: openWakeWord in a Python helper process that Node feeds audio to. |
| `apps/sim` | The browser simulator, and the local API that holds the keys. See [its README](../apps/sim/README.md). |
| `apps/robot` | Peeqo on its Raspberry Pi: the service that drives the real servos, LEDs, screen, mic and buttons, the web panel, phone setup and guided calibration. See [its README](../apps/robot/README.md). |

## How a moment flows

```
mic ─▶ wake word ─▶ recording ─┐
text ──────────────────────────┴─▶ Brain ─(OpenRouter: tools, then GIF + caption + expressions)
                                     │
                                     ▼
                                 BrainBody ─┬─▶ GIF + caption ─▶ face screen
                                            ├─▶ (optional) words ─▶ voice
                                            └─▶ Character (states, expressions)
                                                  ├─▶ HeadAnimator ─▶ MotionGovernor ─▶ servos (sim: 3D model)
                                                  ├─▶ ExpressiveFace ─▶ screen
                                                  ├─▶ LedAnimator ─▶ DotStar ring
                                                  └─▶ sounds ─▶ speaker
```

## Safety

Every head pose, whether from sliders, animations, the brain or anything later, goes through `MotionGovernor`:

- **Refused poses:** any pose that would bring two parts within 0.5 mm of each other. Gaps come from exact
  mesh distances precomputed from the Fusion assembly, and are re-measured independently by
  `npm run check:clearance -w @peeqo/sim`.
- **Also refused:** poses with a horn and leg nearly in line, or a rod end tilted past 18°.
- **Speed limits:** caps on speed, acceleration and servo speed.
- **Paths:** moves are straight lines, and it goes round by the neutral pose when the straight path is blocked.

Every gesture leaves at least 30% of the neck's room to spare. Tests play every gesture and expression through the
real governor.

## Bringing up the robot

The robot runs `apps/robot`: the same brain, character and governor as the simulator, on the Pi. To get it there:

- **Deploy:** flash Raspberry Pi OS Lite (64-bit) with SSH on, then run `npm run deploy -w @peeqo/robot` from a
  laptop. The installer sets up everything else.
- **Wi-Fi:** from a phone. Peeqo shows a QR code for its setup network when it knows no Wi-Fi.
- **Calibration:** guided, from the panel, with the cloth off.
  - Each arm's channel, direction, measured range (its lowest and highest safe points) and level are found by eye.
  - Then the head is levelled with a phone level and the scale checked with a 3° tilt.
  - The servos stay limp until this is done.
  - The measured ranges become hard limits: the governor plans 1.5° inside them, and the driver never goes outside
    them. On the robot, the governor also keeps every horn between 5° and 55°.
- **Still to check on the hardware:**
  - the screen's resolution and rotation;
  - the audio devices;
  - where LED 0 sits;
  - which button is which;
  - backlash and play in the rod ends (the model assumes rigid, perfectly fitted parts).
