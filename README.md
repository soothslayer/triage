# Triage

Spatial inbox-zero for the Meta VR Start contest (productivity track).
Touch or aim at email cards and pinch to read them, flick right to archive, flick left to delete,
drop them in the TODAY bin to keep. Pinch UNDO below the cards to restore the
last archived, deleted, or TODAY card. Mock inbox for now; Gmail OAuth lands later.

**Open-palm carousel spin:** hold either open hand steady anywhere (about
120 ms), then sweep left or right about 12 cm. The whole carousel rotates one
slot in the sweep direction, wrapping around; cards glide to their new slots.
This never archives, deletes, or changes UNDO. Withdraw or close your hand
before another sweep. Pinch-and-flick retains the existing archive/delete
actions. Palm gestures pause while grabbing, composing, or using system UI,
and reset when tracking is lost. Hand-pose and distance thresholds still need
tuning on a physical Quest.

## Stack

Vite + TypeScript + [`@iwsdk/core`](https://iwsdk.dev) 1.0.1 (Meta Immersive Web
SDK — re-exports Three.js, no React in this project). ECS architecture:
components in `src/email-card.ts`, game logic in `src/triage.ts`.

## Run

```sh
npm run dev        # iwsdk-managed dev server (opens managed browser)
npm run typecheck  # tsc --noEmit — run before testing, always
npm test           # card lifecycle regressions against the installed SDK
npm run build      # production build → dist/
```

## Reply and forward inside VR (sample only)

Pinch a card, make a short flick, then release:

- **Up → Reply** (blue cue); **down → Forward** (purple cue).
- **Right → Archive** (green); **left → Delete** (red).
- **TODAY** wins over any flick. Slow/ambiguous diagonal/depth movement does not
  arm a gesture; reversing direction cancels it.

The composer and original email remain in the immersive spatial scene. There
is no browser compose form, 2D compose overlay, custom keyboard, or automatic
exit from XR. The original supports Earlier/Later paging. Background triage is
suspended while composing. Separate REPLY/FORWARD controls remain available.
Select To (Forward only), Subject, or Message in the panel before editing.
Use Message ↑ / ↓ to review longer drafts without opening another surface.

**Voice first:** select **Record** deliberately and allow microphone access if
prompted; use **Stop mic** to finish. Final English transcripts are inserted;
interim text is displayed separately. Review before sending. Permission/service
failures are shown; changing fields, opening the keyboard, cancelling, leaving
XR, losing visibility, or cleanup stops app dictation and ignores late results.
Nothing records automatically; each recording is capped at two minutes.

**Horizon keyboard:** opens automatically when entering the composer, on Message
for a reply or To for a forward. Select its button to reopen the native Meta
Horizon OS system keyboard while XR stays active. Type, then dismiss the keyboard to return
focus to the spatial panel. The default **Mode: Add text** keeps existing text
and appends the new keyboard buffer. Select **Mode: Replace field** before
opening the keyboard to rewrite a field. **Undo edit** restores its value before
the last keyboard session or voice edit; **Paragraph** adds a message paragraph.
A forward needs one recipient; a reply targets the fictional sample sender.

**Simulate send** stores a sample message for this page session and shows spatial
confirmation. **← Back** returns to the inbox and keeps the draft for this session;
open the same message's Reply or Forward to resume. **Cancel** discards the draft. No email service is connected or
email delivered. Sample data resets on reload. Sending leaves the original card
in the inbox and does not alter triage UNDO. If XR is ended externally while a
draft is open, it stays in memory and reappears in the panel on re-entry; it does
not open a desktop form.

### Native keyboard integration and limitations

[Meta's System Keyboard in WebXR guide](https://developers.meta.com/vr/documentation/web/webxr-keyboard/)
documents Quest Browser 26.1+ and the runtime capability
`XRSession.isSystemKeyboardSupported`. On supported sessions, the app focuses an
invisible, in-viewport DOM text field. This is the platform's input bridge; the
OS renders the keyboard and the app renders all compose UI in WebGL. No app key
meshes or Horizon-styled substitute are created. Installed IWSDK 1.0.1 exposes
XRSession; its keyboard input actions are not a native keyboard launcher.
The installed UIKit input implementation also uses DOM-backed text controls.

The bridge uses `input.value`/`oninput`, plus blur and session lifecycle cleanup.
Text uses a textarea for multiline input; recipients/subjects use text inputs.
The OS keyboard owns focus (`visible-blurred`) until dismissed, while the XR
session remains active. No native layout/position control or key events are
assumed. Meta documents a new editing session each time it opens, with the first
keystroke replacing the input's prior value. A fresh buffer plus explicit Add /
Replace modes protects the existing draft from that behavior.

The app feature-detects support. Unsupported browsers/emulators display a clear
message and do not substitute a custom keyboard or browser form. This path must
be tested in Quest Browser; desktop WebXR emulation cannot render Horizon's OS
keyboard. Supported capability does not prove that a particular browser/OS
release successfully displays it.

Voice separately uses `SpeechRecognition` / `webkitSpeechRecognition`.
[MDN documents limited support and possible online processing](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition).
The panel discloses that the browser may send audio to its speech provider. There
is no paid API, app audio upload, fabricated transcript, or custom transcription
backend. Quest speech API/service availability remains unverified. Features
exposed by the native keyboard belong to the OS; the app does not assume it can
programmatically start the keyboard's own dictation.

Tests cover gestures, real SDK near/ray control targets, native-input value
updates using test doubles, append/replace/undo, failure and stale-event handling,
and microphone lifecycle. Browser emulation checks the spatial scene and absence
of DOM compose UI; capability injection tests only the bridge plumbing.

On a real Quest, verify native keyboard launch from near/ray pinches, focus and
blur behavior, first-keystroke replacement protection, multiline edits, Done /
dismiss / re-open, hand gesture thresholds and readability, microphone permission
and actual transcription, interruption cleanup, and performance. No physical
headset validation has been performed here.

## Gesture tuning

A short axis-dominant flick of about 3–4 cm is enough: pinch, move left or right,
then release. Green means archive; red means delete; blue means reply; purple means forward. There is
160 ms of release grace after a qualifying movement, so you can release just
after stopping. Direction follows your facing at the start of the grab.

Swipe thresholds live in `src/swipe.ts` (3 cm minimum, 0.3 m/s average speed,
120 ms movement window). Slow repositioning and tiny tracking jitter do not
qualify. Bin radius and slot layout live in the TUNING block in `src/triage.ts`.
These settings are covered by simulated input tests; tune the feel on a headset.

UNDO works with a near pinch or a ray pinch, including after a replacement
card appears or the inbox reaches zero. It restores only the most recent
action and dims when unavailable or while another card is held.

## Player anchoring

Artificial locomotion is disabled in `iwsdk.config.json`. This is a stationary
inbox with no collision floor; enabling locomotion makes the virtual player
fall under gravity, so the cards and TODAY bin appear to rise out of view.
Head and hand tracking still follow your real movements.

The card arc, TODAY bin, hint, UNDO button, and EXIT card are laid out relative to the
player's head pose, not fixed world coordinates: the layout snapshots head
position + yaw on the first frame, and re-snapshots a few frames after an XR
session starts (the head pose needs a moment to settle). Fixed world
coordinates are unreliable because the XR reference space isn't guaranteed
to line up with where the user stands/faces at session start — this was the
"HUD visible, no cards" bug of 2026-10-11. The HUD was already head-following.

## Leaving the app

- **In-app:** touch or aim at the red EXIT card (left of the arc), then pinch — it calls
  `world.exitXR()` and drops you back to the 2D page.
- **System gesture (no controllers):** turn your palm toward you at eye
  level, pinch thumb + index finger until the indicator fills, then release.
  See [Meta's WebXR hand guide](https://developers.meta.com/vr/documentation/web/webxr-hands/).

## How the gestures work

- `useHandPinchForGrab = true` is set on the GrabSystem in `TriageSystem.init()`
  — without it, bare-hand pinch does nothing (only the squeeze button grabs).
- `HandPinchSystem` bridges native WebXR hand select events to near grabs
  when no gamepad is present (a missing path in IWSDK 1.0.1).
- Cards use one `OneHandGrabbable` handle with `RayInteractable` and an explicit
  pointer filter accepting both grab and ray pointers. `Grabbed` qualify → expand;
  `disqualify` → classify the release.
- Held-hand positions from `player.gripSpaces` feed a short movement window
  in the player's facing frame. On release, a recent sideways flick archives
  (right) or deletes (left). A release over TODAY takes precedence; anything
  else glides home. Each new grab starts a fresh movement window.
- Undo cancels an active dismissal or recreates the original card, returning
  its replacement to the front of the inbox queue.
- `src/mockInbox.ts` → swap for the Gmail data source later. `TriageSystem`
  only consumes `Email[]`, so the swap is local to that module.
