# Peeqo sim

A 3D Peeqo in the browser: neck mechanism, face, LED ring and head motion, all driven through the same
safety governor the robot will use.

## Run

```sh
npm install     # once, from the repo root
npm run sim     # then open the printed URL (http://localhost:5173)
```

## Check

```sh
npm run check                       # typecheck, unit tests, production build
npm run verify:sim -- <screenshot-dir>   # drives the built sim in Chrome, fails on any error
```

## What it models

- **Neck**: `packages/core` holds the kinematics. It uses the same closed-form IK as
  `ServoSimulator/Platform.pde`, and reproduces every pulse in the four 2019 animations exactly.
- **Safety**: every target goes through `MotionGovernor`: sliders, animations, and later the AI. Each target
  is clamped to the safe range (horn limits, reach, singularity margin, joint tilt), then speed- and
  acceleration-limited. Every commanded pose is checked again. The default limits allow nothing further or
  faster than the 2019 animations did.
- **Face**: the 2019 eyes and glasses, drawn on an 800×480 canvas (`packages/face`).
- **LEDs**: the 2019 animations, running on a model of the DotStar strip.

## Assumptions to confirm on the dev kit

- **Neck dimensions**: taken from the 2019 ServoSimulator: base radius 65, platform radius 85, horn 13,
  leg 125, home height 125 mm.
- **Head**: the 2016 v1 CAD, used as a stand-in. To rebuild it:
  `npm run build:head-model -w @peeqo/sim -- path/to/peeqo_design.iges`
- **Wiring and layout**: which rear servo is on which side, and where LED 0 sits.
