# Triage

Spatial inbox-zero for the Meta VR Start contest (productivity track).
Pinch email cards to read them, flick right to archive, flick left to delete,
drop them in the TODAY bin to keep. Mock inbox for now; Gmail OAuth lands later.

## Stack

Vite + TypeScript + [`@iwsdk/core`](https://iwsdk.dev) 1.0.1 (Meta Immersive Web
SDK — re-exports Three.js, no React in this project). ECS architecture:
components in `src/email-card.ts`, game logic in `src/triage.ts`.

## Run

```sh
npm run dev        # iwsdk-managed dev server (opens managed browser)
npm run typecheck  # tsc --noEmit — run before testing, always
npm run build      # production build → dist/
```

## Gesture tuning

All the feel numbers live in the TUNING block at the top of `src/triage.ts`
(`FLICK_SPEED_MPS`, `BIN_RADIUS_M`, slot layout…). They were picked blind —
tune on a real headset.

## Player anchoring

The card arc, TODAY bin, hint, and EXIT card are laid out relative to the
player's head pose, not fixed world coordinates: the layout snapshots head
position + yaw on the first frame, and re-snapshots a few frames after an XR
session starts (the head pose needs a moment to settle). Fixed world
coordinates are unreliable because the XR reference space isn't guaranteed
to line up with where the user stands/faces at session start — this was the
"HUD visible, no cards" bug of 2026-10-11. The HUD was already head-following.

## Leaving the app

- **In-app:** pinch the red EXIT card (left of the arc) — it calls
  `world.exitXR()` and drops you back to the 2D page.
- **System gesture (no controllers):** turn your palm toward you at eye
  level, then pinch-and-hold thumb + index finger until the indicator fills —
  the universal menu opens, then choose Quit.

## How the gestures work

- `useHandPinchForGrab = true` is set on the GrabSystem in `TriageSystem.init()`
  — without it, bare-hand pinch does nothing (only the squeeze button grabs).
- Cards are `OneHandGrabbable` (proximity). `Grabbed` qualify → expand;
  `disqualify` → classify the release.
- Hand velocity is tracked per-frame from `player.gripSpaces` world positions
  with exponential smoothing. On release, a dominant horizontal velocity is a
  flick (right = archive, left = delete); releasing over the TODAY bin keeps;
  anything else lerps home.
- `src/mockInbox.ts` → swap for the Gmail data source later. `TriageSystem`
  only consumes `Email[]`, so the swap is local to that module.
