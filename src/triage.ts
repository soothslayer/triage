/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * TriageSystem — the spatial inbox-zero game loop.
 *
 * Cards (one per unread email) rest in a gentle arc in front of the player.
 * Bare-hand gestures, all via IWSDK's GrabSystem + hand tracking:
 *
 *   PINCH a card ......... grab it; the card scales up and swaps to its
 *                          expanded texture so you can read the full body.
 *   FLICK RIGHT on release  archive  (card flies right and fades)
 *   FLICK LEFT on release .  delete   (card flies left and fades)
 *   RELEASE OVER TODAY BIN  keep for today (card flies into the bin)
 *   RELEASE elsewhere .....  card lerps back to its arc slot
 *   PINCH the EXIT card ...  leave the immersive session (world.exitXR()).
 *                          The Quest system fallback is palm-toward-you +
 *                          pinch, wait for the icon to fill, then release.
 *
 * Flick detection: per-hand velocity is tracked every frame from the
 * grip-space world position (works for hands and controllers). On release,
 * the releasing hand's smoothed velocity classifies the gesture. Thresholds
 * are deliberately conservative — a drop is never a delete.
 *
 * Player anchoring: fixed world coordinates are unreliable — the XR
 * reference space is not guaranteed to line up with where the user is
 * standing/facing when the session starts. So the whole layout (card arc,
 * TODAY bin, hint, EXIT card) anchors to the head pose: once on the first
 * frame (covers the flat/emulator preview) and again a few frames after an
 * XR session starts (covers entering VR from the 2D page). The HUD was
 * already head-following and is untouched.
 *
 * NOTE (hand tuning): these numbers were picked blind, without a headset
 * session. Expect to tune FLICK_SPEED_MPS, BIN_RADIUS_M, and the arc layout
 * on-device. Everything tunable lives in the TUNING block below.
 */

import {
  BoxGeometry,
  CanvasTexture,
  createSystem,
  Grabbed,
  GrabSystem,
  Group,
  Mesh,
  MeshBasicMaterial,
  OneHandGrabbable,
  PlaneGeometry,
  Quaternion,
  RayInteractable,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { CardState, EmailCard } from './email-card.js';
import { MOCK_INBOX } from './mockInbox.js';
import {
  makeCardTextures,
  makeLabelPlane,
  makeTexturedPlane,
} from './textures.js';

// ---------------------------------------------------------------------------
// TUNING — adjust on-device.
//
// The layout is anchored to the player: distances are meters in front of the
// head, heights are offsets from head height. anchorToPlayer() snapshots the
// head pose (position + yaw) on the first frame and re-snapshots a few frames
// after an XR session starts, so the arc is always in front of the player.
// ---------------------------------------------------------------------------
const SLOT_COUNT: number = 5;
const SLOT_DIST = 0.9; // arc distance in front of the player (m)
const SLOT_Y_OFF = -0.28; // below head height (m)
const SLOT_SPREAD = 0.6; // half-width of the arc in meters
const CARD_W = 0.36;
const CARD_H = 0.24;
const CARD_EXPANDED_W = 0.46;
const CARD_EXPANDED_H = 0.64;
const HELD_SCALE = 1.3;
/** Min horizontal hand speed (m/s) to count as a flick. */
const FLICK_SPEED_MPS = 1.0;
/** Flick must be this much stronger on X than on Y/Z to count. */
const FLICK_AXIS_DOMINANCE = 1.5;
/** TODAY bin, mirrored EXIT card: (sideways-m, y-offset-m, distance-m). */
const BIN_X = 0.68;
const BIN_Y_OFF = -0.3;
const BIN_DIST = 0.7;
/** Release within this radius (m) of the bin center = keep for today. */
const BIN_RADIUS_M = 0.3;
const EXIT_X = -0.68;
const EXIT_Y_OFF = -0.3;
const EXIT_DIST = 0.7;
const HINT_Y_OFF = -0.68;
const HINT_DIST = 0.95;
const ZERO_Y_OFF = -0.15;
const ZERO_DIST = 1.3;
/** Exit-animation fly speed (m/s) and fade duration (s). */
const DISMISS_SPEED = 2.4;
const DISMISS_DURATION = 0.55;
/** How fast a dropped card glides home (lerp factor per second). */
const RETURN_LERP = 7;
/** Frames to wait after XR session start before re-anchoring (pose settle). */
const ANCHOR_SETTLE_FRAMES = 6;

interface CardRuntime {
  /** GrabSystem owns this transform; visual expansion stays on its child. */
  root: Group;
  mesh: Mesh;
  mat: MeshBasicMaterial;
  faceTex: CanvasTexture;
  expandedTex: CanvasTexture;
  /** Hand that last held this card ('left' | 'right' | null). */
  lastHand: 'left' | 'right' | null;
  dismissT: number; // < 0 = not dismissing
  dismissVel: Vector3;
  /** Arc slot freed by this dismiss (-1 = none) — refill target. */
  dismissSlot: number;
}

export class TriageSystem extends createSystem({
  cards: { required: [EmailCard] },
  grabbed: { required: [Grabbed] },
}) {
  // --- preallocated temps (never allocate in update()) ---
  private tmpA = new Vector3();
  private tmpB = new Vector3();
  private tmpC = new Vector3();
  private tmpQ = new Quaternion();
  private fwd = new Vector3();
  private headPos = new Vector3();
  private up = new Vector3(0, 1, 0);

  // --- player anchor (position + yaw snapshot) ---
  private anchorPos = new Vector3();
  private anchorYawQ = new Quaternion();
  private anchored = false;
  private hadSession = false;
  private settleFrames = 0;

  // --- per-hand velocity tracking ---
  private handPrevL = new Vector3();
  private handPrevR = new Vector3();
  private handVelL = new Vector3();
  private handVelR = new Vector3();
  private handInitL = false;
  private handInitR = false;

  private grab: GrabSystem | undefined;
  private runtime = new WeakMap<Entity, CardRuntime>();
  /** Email indices not yet on screen, in order. */
  private queue: number[] = [];
  /** Slot occupancy: slot index -> entity (or null). */
  private slots: (Entity | null)[] = [];
  private remaining = 0;

  // --- world-anchored props ---
  private binMesh!: Mesh;
  private binLabel!: Mesh;
  private binPos = new Vector3();
  private exitMesh!: Mesh;
  private exitEntity: Entity | null = null;

  // --- HUD / overlays ---
  private hudCanvas!: HTMLCanvasElement;
  private hudCtx!: CanvasRenderingContext2D;
  private hudTex!: CanvasTexture;
  private hudMesh!: Mesh;
  private hintMesh!: Mesh;
  private zeroMesh!: Mesh;
  private zeroT = -1; // < 0 = hidden
  private hintHidden = false;

  init(): void {
    // Pinch-to-grab: WITHOUT this, GrabSystem only honors the physical
    // squeeze button, so bare hands could never pick up a card.
    this.grab = this.world.getSystem(GrabSystem);
    if (this.grab) {
      this.grab.config.useHandPinchForGrab.value = true;
    }

    this.slots = new Array<Entity | null>(SLOT_COUNT).fill(null);
    this.queue = MOCK_INBOX.map((_, i) => i);
    this.remaining = MOCK_INBOX.length;

    this.buildBin();
    this.buildHud();
    this.buildHint();
    this.buildZeroOverlay();
    this.buildExit();

    // Deal the opening hand (positioned on first anchor).
    for (let s = 0; s < SLOT_COUNT; s++) this.dealIntoSlot(s);
    this.drawHud();

    this.queries.grabbed.subscribe('qualify', (e) => {
      if (e === this.exitEntity) {
        // Pinch the EXIT card → leave the immersive session, back to the page.
        this.world.exitXR();
        return;
      }
      this.onGrab(e);
    });
    this.queries.grabbed.subscribe('disqualify', (e) => this.onRelease(e));
    this.cleanupFuncs.push(
      this.queries.cards.subscribe('disqualify', (e) => this.disposeCardTextures(e)),
      () => {
        for (const e of this.queries.cards.entities) this.disposeCardTextures(e);
      },
    );
  }

  // ------------------------------------------------------- player anchoring

  /**
   * Snapshot the head pose (position + yaw) and lay out the world-anchored
   * content in front of the player. Called on the first frame and again
   * shortly after an XR session starts, so the arc is always where the
   * player is actually looking — never stranded at fixed world coordinates
   * the reference space doesn't line up with.
   */
  private anchorToPlayer(): void {
    this.player.head.getWorldPosition(this.headPos);
    this.player.head.getWorldQuaternion(this.tmpQ);
    // Yaw only: flatten the head's forward so looking up/down doesn't tilt
    // the whole layout.
    this.fwd.set(0, 0, -1).applyQuaternion(this.tmpQ);
    this.fwd.y = 0;
    if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, -1);
    this.fwd.normalize();
    this.anchorYawQ.setFromAxisAngle(
      this.up,
      Math.atan2(-this.fwd.x, -this.fwd.z),
    );
    this.anchorPos.copy(this.headPos);

    for (let s = 0; s < SLOT_COUNT; s++) {
      const e = this.slots[s];
      if (e) this.placeCardInSlot(e, s);
    }

    this.placeLocal(this.binMesh, BIN_X, BIN_Y_OFF, BIN_DIST, false);
    this.binPos.copy(this.binMesh.position);
    this.placeLocal(this.binLabel, BIN_X, BIN_Y_OFF + 0.32, BIN_DIST, true);
    this.placeLocal(this.hintMesh, 0, HINT_Y_OFF, HINT_DIST, true);
    this.placeLocal(this.zeroMesh, 0, ZERO_Y_OFF, ZERO_DIST, true);
    this.placeLocal(this.exitMesh, EXIT_X, EXIT_Y_OFF, EXIT_DIST, true);

    this.anchored = true;
  }

  /** Place a mesh at (x, yOff, dist) in the anchor frame, facing the player. */
  private placeLocal(
    mesh: Mesh,
    x: number,
    yOff: number,
    dist: number,
    facePlayer: boolean,
  ): void {
    this.tmpC.set(x, 0, -dist).applyQuaternion(this.anchorYawQ);
    this.tmpC.add(this.anchorPos);
    this.tmpC.y = this.anchorPos.y + yOff;
    mesh.position.copy(this.tmpC);
    if (facePlayer) {
      mesh.lookAt(this.anchorPos.x, this.tmpC.y, this.anchorPos.z);
    }
  }

  private placeCardInSlot(entity: Entity, slot: number): void {
    const rt = this.runtime.get(entity);
    if (!rt) return;
    const t = SLOT_COUNT === 1 ? 0 : slot / (SLOT_COUNT - 1); // 0..1
    const x = (t - 0.5) * 2 * SLOT_SPREAD;
    const dist = SLOT_DIST + 0.15 * Math.pow(x / SLOT_SPREAD, 2); // gentle arc
    this.tmpB.set(x, 0, -dist).applyQuaternion(this.anchorYawQ);
    this.tmpB.add(this.anchorPos);
    this.tmpB.y = this.anchorPos.y + SLOT_Y_OFF;
    rt.root.position.copy(this.tmpB);
    // Face the player (plane +Z toward the head).
    rt.root.lookAt(this.anchorPos.x, this.tmpB.y, this.anchorPos.z);
    const home = entity.getVectorView(EmailCard, 'homePosition');
    home[0] = this.tmpB.x;
    home[1] = this.tmpB.y;
    home[2] = this.tmpB.z;
  }

  // ------------------------------------------------------------------ setup

  private dealIntoSlot(slot: number): void {
    const emailIndex = this.queue.shift();
    if (emailIndex === undefined) return;
    const email = MOCK_INBOX[emailIndex];
    const { face, expanded } = makeCardTextures(email);
    const mat = new MeshBasicMaterial({ map: face, transparent: true });
    const mesh = new Mesh(new PlaneGeometry(CARD_W, CARD_H), mat);
    const root = new Group();
    root.add(mesh);
    const entity = this.world.createTransformEntity(root);
    entity.addComponent(EmailCard, {
      emailIndex,
      state: CardState.Queued,
      slotIndex: slot,
    });
    entity.addComponent(OneHandGrabbable, { rotate: false });
    entity.addComponent(RayInteractable);
    // Keep one handle, accepting both near grabs and ray-selected pinches.
    root.pointerEventsType = { allow: ['grab', 'ray'] };
    this.runtime.set(entity, {
      root,
      mesh,
      mat,
      faceTex: face,
      expandedTex: expanded,
      lastHand: null,
      dismissT: -1,
      dismissVel: new Vector3(),
      dismissSlot: -1,
    });
    this.slots[slot] = entity;
    if (this.anchored) this.placeCardInSlot(entity, slot);
  }

  private buildBin(): void {
    this.binMesh = new Mesh(
      new BoxGeometry(0.3, 0.3, 0.3),
      new MeshBasicMaterial({
        color: 0x2fbf71,
        transparent: true,
        opacity: 0.22,
      }),
    );
    this.world.createTransformEntity(this.binMesh);
    this.binLabel = makeLabelPlane('TODAY', 0.34, {
      color: '#7dffb0',
      sub: 'drop here to keep',
    });
    this.world.createTransformEntity(this.binLabel);
  }

  private buildExit(): void {
    this.exitMesh = makeLabelPlane('EXIT', 0.36, {
      fontPx: 96,
      color: '#ff8080',
      sub: 'aim and pinch to leave',
    });
    this.exitEntity = this.world.createTransformEntity(this.exitMesh);
    this.exitEntity.addComponent(OneHandGrabbable, { rotate: false, translate: false });
    this.exitEntity.addComponent(RayInteractable);
    this.exitMesh.pointerEventsType = { allow: ['grab', 'ray'] };
  }

  private buildHud(): void {
    this.hudCanvas = document.createElement('canvas');
    this.hudCanvas.width = 512;
    this.hudCanvas.height = 128;
    this.hudCtx = this.hudCanvas.getContext('2d')!;
    this.hudTex = new CanvasTexture(this.hudCanvas);
    this.hudMesh = makeTexturedPlane(0.55, 0.1375, this.hudTex);
    this.world.createTransformEntity(this.hudMesh);
  }

  private drawHud(): void {
    const ctx = this.hudCtx;
    ctx.clearRect(0, 0, 512, 128);
    ctx.fillStyle = 'rgba(10, 14, 28, 0.72)';
    ctx.beginPath();
    ctx.roundRect(4, 4, 504, 120, 40);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 56px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      this.remaining === 0 ? 'Inbox zero' : `${this.remaining} remaining`,
      256,
      84,
    );
    this.hudTex.needsUpdate = true;
  }

  private buildHint(): void {
    this.hintMesh = makeLabelPlane('Touch or aim, then pinch', 1.15, {
      fontPx: 56,
      color: '#cfe0ff',
      sub: 'flick → archive · ← flick delete · drop in TODAY to keep',
    });
    this.world.createTransformEntity(this.hintMesh);
  }

  private buildZeroOverlay(): void {
    this.zeroMesh = makeLabelPlane('Inbox zero.', 1.5, {
      fontPx: 120,
      color: '#7dffb0',
      sub: 'nice work — see you tomorrow',
    });
    this.zeroMesh.visible = false;
    this.world.createTransformEntity(this.zeroMesh);
  }

  // ------------------------------------------------------------- gestures

  private onGrab(entity: Entity): void {
    const rt = this.runtime.get(entity);
    if (!rt || rt.dismissT >= 0) return;
    entity.setValue(EmailCard, 'state', CardState.Held);
    // Swap to the expanded texture + grow, so the full body is readable.
    rt.mat.map = rt.expandedTex;
    rt.mat.needsUpdate = true;
    rt.mesh.scale.setScalar(HELD_SCALE);
    // Widen the card to the expanded aspect while held.
    rt.mesh.scale.x *= CARD_EXPANDED_W / CARD_W;
    rt.mesh.scale.y *= CARD_EXPANDED_H / CARD_H;
  }

  private onRelease(entity: Entity): void {
    const rt = this.runtime.get(entity);
    if (!rt || rt.dismissT >= 0) return;
    // Restore compact look first; dismiss handlers re-hide below.
    rt.mat.map = rt.faceTex;
    rt.mat.needsUpdate = true;
    rt.mesh.scale.setScalar(1);

    const hand = rt.lastHand;
    const vel = hand === 'left' ? this.handVelL : this.handVelR;
    const ax = Math.abs(vel.x);

    entity.object3D?.getWorldPosition(this.tmpA);

    if (
      hand !== null &&
      ax > FLICK_SPEED_MPS &&
      ax > FLICK_AXIS_DOMINANCE * Math.abs(vel.y) &&
      ax > FLICK_AXIS_DOMINANCE * Math.abs(vel.z)
    ) {
      // --- FLICK: horizontal throw classifies the triage action ---
      const dir = vel.x > 0 ? 1 : -1; // +x = right = archive
      rt.dismissVel.set(dir * DISMISS_SPEED, 0.7, -0.4);
      this.beginDismiss(entity, rt);
      this.hideHint();
    } else if (this.tmpA.distanceTo(this.binPos) < BIN_RADIUS_M) {
      // --- BIN: released over TODAY → keep for today ---
      rt.dismissVel.copy(this.tmpB.copy(this.binPos).sub(this.tmpA).normalize());
      this.beginDismiss(entity, rt);
      this.hideHint();
    } else {
      // --- DROP: glide back to the arc slot ---
      entity.setValue(EmailCard, 'state', CardState.Returning);
    }
  }

  private beginDismiss(entity: Entity, rt: CardRuntime): void {
    if (rt.dismissT >= 0) return;
    // Inherited by the visual child: the fading card is no longer a target.
    rt.root.pointerEvents = 'none';
    entity.setValue(EmailCard, 'state', CardState.Dismissed);
    rt.dismissT = 0;
    const slot = entity.getValue(EmailCard, 'slotIndex') ?? -1;
    rt.dismissSlot = slot;
    if (slot >= 0 && slot < SLOT_COUNT) this.slots[slot] = null;
    entity.setValue(EmailCard, 'slotIndex', -1);
    this.remaining = Math.max(0, this.remaining - 1);
    this.drawHud();
  }

  private disposeCardTextures(entity: Entity): void {
    const rt = this.runtime.get(entity);
    if (!rt) return;
    // Entity disposal only sees the currently attached map. Own both textures
    // here, and detach the map so SDK resource cleanup cannot dispose it twice.
    rt.mat.map = null;
    rt.faceTex.dispose();
    rt.expandedTex.dispose();
    this.runtime.delete(entity);
  }

  private hideHint(): void {
    if (!this.hintHidden) {
      this.hintHidden = true;
      this.hintMesh.visible = false;
    }
  }

  // ---------------------------------------------------------------- update

  private trackHand(hand: 'left' | 'right', delta: number): void {
    const space = this.player.gripSpaces[hand];
    if (!space) return;
    space.getWorldPosition(this.tmpA);
    const prev = hand === 'left' ? this.handPrevL : this.handPrevR;
    const vel = hand === 'left' ? this.handVelL : this.handVelR;
    const init = hand === 'left' ? this.handInitL : this.handInitR;
    if (!init) {
      prev.copy(this.tmpA);
      vel.set(0, 0, 0);
      if (hand === 'left') this.handInitL = true;
      else this.handInitR = true;
      return;
    }
    if (delta > 0) {
      // Instantaneous velocity, then exponential smoothing to kill jitter.
      this.tmpB.copy(this.tmpA).sub(prev).divideScalar(delta);
      vel.lerp(this.tmpB, 0.4);
    }
    prev.copy(this.tmpA);
  }

  private updateHudPose(): void {
    this.player.head.getWorldPosition(this.headPos);
    this.player.head.getWorldQuaternion(this.tmpQ);
    this.fwd.set(0, 0, -1).applyQuaternion(this.tmpQ);
    this.tmpA.copy(this.headPos).addScaledVector(this.fwd, 1.3);
    this.tmpA.y = this.headPos.y + 0.38;
    this.hudMesh.position.copy(this.tmpA);
    this.hudMesh.lookAt(this.headPos);
  }

  update(delta: number): void {
    if (delta <= 0) return;

    // 0. Anchor the layout to the player: once on the first frame, and again
    //    shortly after an XR session starts (head pose needs a few frames
    //    to settle once the session is live).
    const hasSession = this.world.xrSession != null;
    if (!this.anchored) {
      this.anchorToPlayer();
    } else if (hasSession && !this.hadSession) {
      this.settleFrames = ANCHOR_SETTLE_FRAMES;
    }
    if (this.settleFrames > 0) {
      this.settleFrames -= 1;
      if (this.settleFrames === 0) this.anchorToPlayer();
    }
    this.hadSession = hasSession;

    // 1. Hand velocity, both hands, every frame (needed at release time).
    this.trackHand('left', delta);
    this.trackHand('right', delta);

    // 2. Remember which hand holds each grabbed card (getHolderHand is only
    //    valid while grabbed — after release it returns null).
    if (this.grab) {
      for (const entity of this.queries.grabbed.entities) {
        const rt = this.runtime.get(entity);
        if (rt) rt.lastHand = this.grab.getHolderHand(entity);
      }
    }

    // 3. Card state machines.
    for (const entity of this.queries.cards.entities) {
      const rt = this.runtime.get(entity);
      if (!rt) continue;
      const state = entity.getValue(EmailCard, 'state');

      if (state === CardState.Returning) {
        const home = entity.getVectorView(EmailCard, 'homePosition');
        this.tmpA.set(home[0], home[1], home[2]);
        const mesh = rt.root;
        mesh.position.lerp(this.tmpA, Math.min(1, RETURN_LERP * delta));
        if (mesh.position.distanceToSquared(this.tmpA) < 1e-6) {
          mesh.position.copy(this.tmpA);
          entity.setValue(EmailCard, 'state', CardState.Queued);
        }
      } else if (state === CardState.Dismissed && rt.dismissT >= 0) {
        rt.dismissT += delta;
        rt.root.position.addScaledVector(rt.dismissVel, delta);
        rt.mat.opacity = Math.max(
          0,
          1 - rt.dismissT / DISMISS_DURATION,
        );
        if (rt.dismissT >= DISMISS_DURATION) {
          const refillSlot = rt.dismissSlot;
          entity.dispose();
          // Refill the freed slot from the queue, if mail remains.
          if (refillSlot >= 0) this.dealIntoSlot(refillSlot);
          if (this.remaining === 0 && this.zeroT < 0) {
            this.zeroT = 0;
            this.zeroMesh.visible = true;
            this.drawHud();
          }
        }
      }
    }

    // 4. Inbox-zero celebration pulse.
    if (this.zeroT >= 0) {
      this.zeroT += delta;
      const s = 1 + 0.06 * Math.sin(this.zeroT * 6);
      this.zeroMesh.scale.setScalar(s);
      if (this.zeroT > 5) {
        this.zeroMesh.visible = false;
        this.zeroT = -2; // done; don't retrigger
      }
    }

    // 5. HUD follows the player.
    this.updateHudPose();
  }
}
