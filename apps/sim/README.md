# Peeqo sim

A 3D Peeqo dev kit in the browser: neck mechanism, face, LED ring and head motion, all driven through the
same safety governor the robot will use.

## Run

```sh
npm install     # once, from the repo root
npm run sim     # then open the printed URL (http://localhost:5173)
```

## Check

```sh
npm run check                                # typecheck, unit tests, production build
npm run verify:sim -- <screenshot-dir>       # drives the built sim in Chrome, fails on any error
npm run check:clearance -w @peeqo/sim        # re-measures the real meshes at 500 safe poses (a few minutes)
```

## Model and safety

1. **Model.** `npm run build:model -w @peeqo/sim -- path/to/peeqo-assembly.stp` builds
   `src/assets/peeqo-devkit.glb` from the dev kit's Fusion 360 assembly.
   - **Bodies:** every part is attached to the rigid body it moves with.
   - **Servo hubs:** they're screwed to the U-horn, so they turn with it.
   - **Joint axes:** these come from the CAD's holes and balls.
   - **Measurements:** the builder re-measures the neck and fails if it no longer matches `DEV_KIT_GEOMETRY`.
   - **Loose parts:** parts that float loose in the CAD are left out and listed in the model.
2. **Collisions.** `npm run build:clearance -w @peeqo/sim` measures exact triangle-to-triangle gaps between
   every pair of bodies, in parallel (about 15 minutes on 12 cores).
   - **Tables:** the pairs that come close (U-horn and base, U-horn and U-horn, leg and base, leg and head)
     get guaranteed-clearance tables over the joint angles they depend on. These go to
     `packages/core/src/devKitClearance.ts`.
   - **Everything else:** each remaining pair is proven clear for every joint angle the tables admit.
   - **Rebuilds:** a unit test fails if the model changes without the tables being rebuilt.
3. **Enforcement.** The governor refuses any pose where two parts would come closer than 0.5 mm.
   - **Every motion source:** this covers sliders, animations, and later the AI.
   - **Paths:** it moves in straight lines. The safe range isn't convex, so when the straight line to a goal
     is blocked, it goes round by the neutral pose.
   - **Margin:** the 0.5 mm covers the kinematic model's 0.2 mm error and mesh tessellation.
   - **Independent checks:** `check:clearance` and `verify:sim` re-measure the real meshes at poses the core
     accepts, including poses on the edge of the safe range, and fail if any gap is smaller than promised.

## Brain

`Brain` (`packages/brain`) is Peeqo's mind. In the sim, talk to it in the **Talk to Peeqo** box, or out loud.

- **A turn:**
  - Peeqo thinks; the model answers with one `respond` call: one or two expressions, a reaction GIF and a caption
    of at most six words, all in one round trip (about 2 to 4 s).
  - It shows how it feels, then the GIF plays on its face screen with the caption over it, meme style.
  - Peeqo doesn't talk, as in 2019. Facts (a time, a temperature) go in the caption. Without GIFs, the caption
    shows above its eyes.
  - **Speak aloud** turns on the browser's voice instead: spoken replies, with a GIF now and then.
  - Its state follows along: listening, then thinking, then idle (speaking, with the voice on).
- **Offline brain (the default):** a scripted stand-in with written answers in Peeqo's voice. It needs no key
  or network, and the tests use it. It can use the tools too, but cannot understand speech.
- **Live brain:** OpenRouter, defaulting to `google/gemini-3.8-flash` (it takes audio and uses tools).
  - Put `OPENROUTER_API_KEY` (and `KLIPY_API` for GIFs) in the repo's `.env`, which git ignores.
  - Run `npm run sim`.
  - The dev server proxies the calls (`apps/sim/server/api.ts`), so the keys never reach the page.
  - The proxy only answers the simulator page itself; other sites are refused.
  - It only passes on Claude and Gemini models, with replies capped at 1,000 tokens.
- **Voice:** what you say goes to the model as a recording, with no transcription step. The model writes down
  what it heard, which shows in the transcript.
  - **Mic:** records until you stop talking.
  - **Wake word:** tick it and say "hey jarvis" (a ready-made openWakeWord model; "hey Peeqo" needs training).
    It needs `npm run setup -w @peeqo/wakeword` once (Python 3.10 or newer); see `packages/wakeword`.
  - The page streams the microphone to the dev server (`/api/voice`), where the detector also judges when you
    have stopped talking. Without it set up, Mic still works and judges by loudness.
  - With **Speak aloud** on, Peeqo doesn't listen while it is talking, so it doesn't hear itself.
- **Tools:** the model can check the time, set, list and cancel timers and reminders, and look up the weather.
  - Timers and reminders are kept in the page (they survive a reload), and Peeqo announces them when due, with a
    GIF.
  - Weather comes from Open-Meteo (free, no key). Set `PEEQO_HOME` in `.env` (e.g. `Pune, India`) so "what's the
    weather?" needs no place.
  - A turn that uses a tool takes two model calls: about 5 to 8 s with speech.
- **GIFs:** come from Klipy.
  - Searches are cached on disk, and an hourly budget of 90 keeps under the key's 100.
  - Media is served from the dev server, so the face can draw it.
- **Live check:** `node packages/brain/scripts/live-check.ts "hello"` talks to the real model from the terminal;
  `--speak` sends each line as speech (macOS).
- **On the robot:** the same `Brain` will call OpenRouter and Klipy directly, with the keys from its own `.env`,
  and the same wake word detector will listen to its microphone.

## Character

`Character` (`packages/character`) is Peeqo as a character. Everything above (head, face, ring, voice) is
driven through it.

- **States:** idle, listening, thinking, speaking and sleeping. Each sets the resting face, gaze, LED ring and
  how lively the head is, with a small greeting gesture on entry.
- **Expressions:** 23 so far (happy, excited, laugh, love, sad, grumpy, surprised, scared, sleepy, curious,
  confused, thinking, yes, no, hello, bye, shy, wink, celebrate, alert, oops, sigh, wonder). Each is a few
  timed steps that move the head, eyes, ring and voice together. When it ends, whatever it changed returns to
  the current state.
- **Life between conversations (`Life`):**
  - while idle, Peeqo now and then does something small on its own, such as a curious look or a little
    wonder;
  - left alone longer, its habits drift toward boredom: sighs, then yawns;
  - after five quiet minutes it falls asleep, and anything that involves it wakes it with a start;
  - it never interrupts listening, thinking or speaking.
- **Voice:** short chirps, coos and bloops are synthesized in plain TypeScript (`sounds.ts`). The sim plays them
  through Web Audio; the robot can play the same samples.
- **Safety:** tests play every expression from several states through the real governor, and check it never
  has to hold the head back.

## Head motion

The animator in `packages/core` (`HeadAnimator`) turns gestures into smooth targets for the governor, 100 times
a second. The same code will drive the robot.

- **Gestures:** 16 so far (`headAnimations.ts`): nod, shake, tilt, look-up, look-down, droop, perk-up, bounce,
  wiggle, think, listen, doze, sigh, startle, groove and hello. Each is a set of keyframes joined by curves
  that ease through every turn and never overshoot a key. Small opposite moves before big ones give
  anticipation.
- **Follow-through:** everything passes through a slightly underdamped spring, so moves settle with a little
  weight. Each play varies by a few percent, so no gesture repeats exactly.
- **Alive layer:** breathing, a slow wander, and now and then a glance or a curious tilt. An energy level
  (0–1) sets its size and pace, it shrinks under gestures, and it can be switched off.
- **Safety:** gestures use height to gain tilt, because the neck's room is a double cone. Every gesture keeps
  at least 30% of the room to spare. Tests play them all, with variation and the alive layer, and check that
  every frame is safe and the governor never has to hold anything back.

## Face

`ExpressiveFace` (`packages/face`) keeps Peeqo's 2019 look: black eyes on white, in the same place, so the
glasses overlays still fit.

- **16 emotions:** neutral, happy, excited, love, sad, angry, surprised, scared, sleepy, curious, confused,
  thinking, listening, shy, wink and skeptical.
- **Shapes:** each eye is shaped by its size, openness, a curved and slanted top lid, a smiling lower lid,
  catch-lights and, for love, a beating heart. Springs blend between emotions, so changes pop and settle.
- **Alive on its own:** varied blinks (sometimes double, often during a big glance), saccades with
  micro-saccades between them, and a gaze that follows the emotion. It can also be told where to look.
- **2019 eyes:** still available from the panel or with `?face=classic`.

## LED ring

`LedAnimator` (`packages/core`) drives the 12 DotStar LEDs with smooth, time-based patterns.

- **Looping:** glow, breathe, heartbeat, spin, listen, speak (follows a voice level) and rainbow.
- **Sparkle:** random twinkles that flash toward white at their peak.
- **One-shots:** success, error and wake. Each returns to whatever was looping before.
- **Quality:**
  - patterns crossfade;
  - output is gamma-corrected;
  - output combines the LEDs' 5-bit brightness with their 8-bit colour, so dim fades stay smooth.
- **2019 animations:** still available. Whichever animation started last drives the ring.

## Neck (dev kit, from the CAD)

- **Servos:** shafts 27.32 mm from the centre, 42 mm up. Each servo has a U-horn with its hubs.
- **Legs:** each is pinned 7 mm from its shaft and is two arms.
- **Rod ends:** 34.32 mm from the centre, 100.1 mm up. Each eye turns freely on its screw and tilts at most
  18°; it would touch the lugs at 23.7°.
- **Rest:** with the horns level (as assembled), the U-horns rest 0.38 mm above the servo holders. Their
  horns must stay above 0.9°, so the robot idles at a raised neutral pose instead: level, 3.2 mm up, horns
  at 27.3°.
- **Range from neutral:** pitch −5.2° to +5.1°, roll ±5.9°, and 0.1–6.2 mm of height when level. Upward and
  sideways it is limited by horns nearing line with their legs; downward by the U-horns nearing their holders.
- **Closest approach:** at the edge of the safe range, a U-horn comes within 0.53 mm of its holder. The rod
  ends stay at least 1.2 mm from the head, and neighbouring U-horns stay 1.6 mm apart.

## Before moving the real robot

- **Servo calibration:** find which pulse puts each horn level and which way it turns. The 2019 pulse
  mapping does not hold for the dev kit.
- **Wiring:** which PCA9685 channel drives which servo, and where LED 0 sits.
