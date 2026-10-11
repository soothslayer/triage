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
 *
 * Flick detection: per-hand velocity is tracked every frame from the
 * grip-space world position (works for hands and controllers). On release,
 * the releasing hand's smoothed velocity classifies the gesture. Thresholds
 * are deliberately conservative — a drop is never a delete.
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
  Mesh,
  MeshBasicMaterial,
  OneHandGrabbable,
  PlaneGeometry,
  Quaternion,
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
// ---------------------------------------------------------------------------
const SLOT_COUNT: number = 5;
const SLOT_Y = 1.32;
const SLOT_Z = -0.9;
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
/** Release within this radius (m) of the bin center = keep for today. */
const BIN_RADIUS_M = 0.3;
const BIN_POS = new Vector3(0.68, 1.02, -0.7);
/** Exit-animation fly speed (m/s) and fade duration (s). */
const DISMISS_SPEED = 2.4;
const DISMISS_DURATION = 0.55;
/** How fast a dropped card glides home (lerp factor per second). */
const RETURN_LERP = 7;

interface CardRuntime {
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
  grabbed: { required: [EmailCard, Grabbed] },
}) {
  // --- preallocated temps (never allocate in update()) ---
  private tmpA = new Vector3();
  private tmpB = new Vector3();
  private tmpC = new Vector3();
  private tmpQ = new Quaternion();
  private fwd = new Vector3();
  private headPos = new Vector3();

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

    // Deal the opening hand.
    for (let s = 0; s < SLOT_COUNT; s++) this.dealIntoSlot(s);
    this.drawHud();

    this.queries.grabbed.subscribe('qualify', (e) => this.onGrab(e));
    this.queries.grabbed.subscribe('disqualify', (e) => this.onRelease(e));
    this.cleanupFuncs.push(() => {
      this.runtime = new WeakMap();
    });
  }

  // ------------------------------------------------------------------ setup

  private slotPosition(slot: number, out: Vector3): Vector3 {
    const t = SLOT_COUNT === 1 ? 0 : slot / (SLOT_COUNT - 1); // 0..1
    const x = (t - 0.5) * 2 * SLOT_SPREAD;
    const z = SLOT_Z - 0.15 * Math.pow(x / SLOT_SPREAD, 2); // gentle arc
    return out.set(x, SLOT_Y, z);
  }

  private dealIntoSlot(slot: number): void {
    const emailIndex = this.queue.shift();
    if (emailIndex === undefined) return;
    const email = MOCK_INBOX[emailIndex];
    const { face, expanded } = makeCardTextures(email);
    const mat = new MeshBasicMaterial({ map: face, transparent: true });
    const mesh = new Mesh(new PlaneGeometry(CARD_W, CARD_H), mat);
    const entity = this.world.createTransformEntity(mesh);
    entity.addComponent(EmailCard, {
      emailIndex,
      state: CardState.Queued,
      slotIndex: slot,
    });
    entity.addComponent(OneHandGrabbable, { rotate: false });
    const home = entity.getVectorView(EmailCard, 'homePosition');
    this.slotPosition(slot, this.tmpA);
    home[0] = this.tmpA.x;
    home[1] = this.tmpA.y;
    home[2] = this.tmpA.z;
    mesh.position.copy(this.tmpA);
    // Face the player (plane +Z toward origin).
    mesh.lookAt(0, this.tmpA.y, 0);

    this.runtime.set(entity, {
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
  }

  private buildBin(): void {
    const bin = new Mesh(
      new BoxGeometry(0.3, 0.3, 0.3),
      new MeshBasicMaterial({
        color: 0x2fbf71,
        transparent: true,
        opacity: 0.22,
      }),
    );
    bin.position.copy(BIN_POS);
    this.world.createTransformEntity(bin);
    const label = makeLabelPlane('TODAY', 0.34, {
      color: '#7dffb0',
      sub: 'drop here to keep',
    });
    label.position.set(BIN_POS.x, BIN_POS.y + 0.32, BIN_POS.z);
    this.world.createTransformEntity(label);
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
    this.hintMesh = makeLabelPlane('Pinch a card to read it', 1.15, {
      fontPx: 56,
      color: '#cfe0ff',
      sub: 'flick → archive · ← flick delete · drop in TODAY to keep',
    });
    this.hintMesh.position.set(0, 0.92, -0.95);
    this.world.createTransformEntity(this.hintMesh);
  }

  private buildZeroOverlay(): void {
    this.zeroMesh = makeLabelPlane('Inbox zero.', 1.5, {
      fontPx: 120,
      color: '#7dffb0',
      sub: 'nice work — see you tomorrow',
    });
    this.zeroMesh.position.set(0, 1.45, -1.3);
    this.zeroMesh.visible = false;
    this.world.createTransformEntity(this.zeroMesh);
  }

  // ------------------------------------------------------------- gestures

  private onGrab(entity: Entity): void {
    const rt = this.runtime.get(entity);
    if (!rt) return;
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
    if (!rt) return;
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
    } else if (this.tmpA.distanceTo(BIN_POS) < BIN_RADIUS_M) {
      // --- BIN: released over TODAY → keep for today ---
      rt.dismissVel.copy(this.tmpB.copy(BIN_POS).sub(this.tmpA).normalize());
      this.beginDismiss(entity, rt);
      this.hideHint();
    } else {
      // --- DROP: glide back to the arc slot ---
      entity.setValue(EmailCard, 'state', CardState.Returning);
    }
  }

  private beginDismiss(entity: Entity, rt: CardRuntime): void {
    entity.setValue(EmailCard, 'state', CardState.Dismissed);
    rt.dismissT = 0;
    const slot = entity.getValue(EmailCard, 'slotIndex') ?? -1;
    rt.dismissSlot = slot;
    if (slot >= 0 && slot < SLOT_COUNT) this.slots[slot] = null;
    entity.setValue(EmailCard, 'slotIndex', -1);
    this.remaining = Math.max(0, this.remaining - 1);
    this.drawHud();
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
        const mesh = rt.mesh;
        mesh.position.lerp(this.tmpA, Math.min(1, RETURN_LERP * delta));
        if (mesh.position.distanceToSquared(this.tmpA) < 1e-6) {
          mesh.position.copy(this.tmpA);
          entity.setValue(EmailCard, 'state', CardState.Queued);
        }
      } else if (state === CardState.Dismissed && rt.dismissT >= 0) {
        rt.dismissT += delta;
        rt.mesh.position.addScaledVector(rt.dismissVel, delta);
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
