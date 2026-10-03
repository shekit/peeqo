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
