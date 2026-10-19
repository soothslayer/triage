/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * TriageSystem — the spatial inbox-zero game loop.
 *
 * Cards (one per unread email) rest in a gentle arc in front of the player.
 * Bare-hand gestures via IWSDK's GrabSystem and WebXR hand joints:
 *
 *   PINCH a card ......... grab it; the card scales up and swaps to its
 *                          expanded texture so you can read the full body.
 *   FLICK RIGHT on release  archive  (card flies right and fades)
 *   FLICK LEFT on release .  delete   (card flies left and fades)
 *   RELEASE OVER TODAY BIN  keep for today (card flies into the bin)
 *   RELEASE elsewhere .....  card lerps back to its arc slot
 *   PINCH UNDO ........... restore the last dismissed card.
 *   FLICK UP / DOWN ..... reply / forward inside VR, without dismissing.
 *   PINCH REPLY / FORWARD  alternative actions for the last selected card.
 *   PALM MENU ............ turn either open palm toward your face and hold:
 *                          a menu appears with EXIT (leave VR), UNDO
 *                          (restore last dismissal), and HELP (how to play).
 *                          The Quest system fallback is palm-toward-you +
 *                          pinch, wait for the icon to fill, then release.
 *
 * Flick detection uses a short movement window in the player's facing frame.
 * Small sideways flicks arm a color cue, with a brief grace period to release.
 * UNDO restores the most recent dismissal, including after the slot refills.
 *
 * Player anchoring: fixed world coordinates are unreliable — the XR
 * reference space is not guaranteed to line up with where the user is
 * standing/facing when the session starts. So the whole layout (card arc,
 * TODAY bin, hint, palm menu) anchors to the head pose: once on the first
 * frame (covers the flat/emulator preview) and again a few frames after an
 * XR session starts (covers entering VR from the 2D page). The HUD was
 * already head-following and is untouched.
 *
 * NOTE (hand tuning): these numbers were picked blind, without a headset
 * session. Expect to tune src/swipe.ts, BIN_RADIUS_M, and the arc layout
 * on-device. Layout tuning lives in the TUNING block below.
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
import { SwipeTracker } from './swipe.js';
import { OpenPalmReader, PalmSwipeTracker } from './palm-swipe.js';
import { PalmFacingReader } from './palm-menu.js';
import { SampleMail } from './sample-mail.js';
import type { ComposeMode } from './sample-mail.js';
import { ImmersiveComposer } from './immersive-composer.js';
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
/** TODAY bin position: (sideways-m, y-offset-m, distance-m). */
const BIN_X = 0.68;
const BIN_Y_OFF = -0.3;
const BIN_DIST = 0.7;
/** Release within this radius (m) of the bin center = keep for today. */
const BIN_RADIUS_M = 0.3;
/** Palm menu layout: (y-offset-m, distance-m); buttons at +/- MENU_SPREAD. */
const MENU_Y_OFF = -0.46;
const MENU_DIST = 0.8;
const MENU_SPREAD = 0.34;
/** Palm-facing-head dot product that starts counting a menu summon. */
const MENU_FACE_ON = 0.65;
/** Dot product below which the menu starts hiding. */
const MENU_FACE_OFF = 0.35;
/** Seconds of sustained palm-facing to show the menu. */
const MENU_HOLD_S = 0.35;
/** Seconds of palm-away before the menu hides. */
const MENU_HIDE_S = 0.4;
/** Palm must be this close to the head (m) to summon the menu. */
const MENU_HEAD_DIST_M = 0.75;
/** Open-palm carousel sweep: turned off 2026-10-16 in favor of the
 *  upcoming pinch-drag carousel. Trackers kept for reference. */
const PALM_SWIPE_ENABLED = false;
const UNDO_Y_OFF = -0.65;
const UNDO_DIST = 0.7;
const HINT_Y_OFF = -1.02;
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
const HANDS = ['left', 'right'] as const;

interface CardRuntime {
  /** GrabSystem owns this transform; visual expansion stays on its child. */
  root: Group;
  mesh: Mesh;
  mat: MeshBasicMaterial;
  faceTex: CanvasTexture;
  expandedTex: CanvasTexture;
  /** Hand that last held this card ('left' | 'right' | null). */
  lastHand: 'left' | 'right' | null;
  swipe: SwipeTracker;
  dismissT: number; // < 0 = not dismissing
  dismissVel: Vector3;
  /** Arc slot freed by this dismiss (-1 = none) — refill target. */
  dismissSlot: number;
  /**
   * Target orientation while gliding to a new slot (carousel spin). Null
   * for ordinary returns, which keep their slot and facing.
   */
  returnQuat: Quaternion | null;
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
  /** Scratch object for lookAt-based slot orientation (never added to scene). */
  private tmpObj = new Group();

  // --- player anchor (position + yaw snapshot) ---
  private anchorPos = new Vector3();
  private anchorYawQ = new Quaternion();
  private anchored = false;
  private hadSession = false;
  private settleFrames = 0;

  private elapsed = 0;
  private lastAction: { emailIndex: number; slot: number; entity: Entity | null } | null = null;

  private grab: GrabSystem | undefined;
  private runtime = new WeakMap<Entity, CardRuntime>();
  /** Email indices not yet on screen, in order. */
  private queue: number[] = [];
  /** Slot occupancy: slot index -> entity (or null). */
  private slots: (Entity | null)[] = [];
  private remaining = 0;
  private palmHands = HANDS.map((hand) => ({
    hand, reader: new OpenPalmReader(), swipe: new PalmSwipeTracker(),
    source: undefined as XRInputSource | undefined,
  }));
  private palmCooldownUntil = 0;

  // --- world-anchored props ---
  private binMesh!: Mesh;
  private binLabel!: Mesh;
  private binPos = new Vector3();
  // --- palm menu (EXIT / UNDO / HELP buttons) ---
  private menuMeshes: Mesh[] = [];
  private menuExitEntity: Entity | null = null;
  private menuUndoEntity: Entity | null = null;
  private menuHelpEntity: Entity | null = null;
  private menuVisible = false;
  private menuHoldT = 0;
  private menuHideT = 0;
  private menuReader = new PalmFacingReader();

  private undoMesh!: Mesh;
  private undoEntity: Entity | null = null;
  readonly mail = new SampleMail(MOCK_INBOX);
  private composer!: ImmersiveComposer;
  private draftWasOpen = false;
  private composeFeedbackUntil = -1;
  private replyMesh!: Mesh;
  private forwardMesh!: Mesh;
  private replyEntity: Entity | null = null;
  private forwardEntity: Entity | null = null;
  private selectionMesh!: Mesh;
  private selectionCanvas!: HTMLCanvasElement;
  private selectionTex!: CanvasTexture;

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
    this.buildPalmMenu();
    this.buildUndo();
    this.buildComposeActions();
    this.composer = new ImmersiveComposer(this.world, this.mail);
    const stopVoice = () => this.composer.editor.voice.abort();
    const sessionEnd = () => { stopVoice(); this.composer.setXR(false); };
    this.xrManager.addEventListener('sessionend', sessionEnd);
    const visibility = () => {
      if (this.world.xrSession?.visibilityState !== 'visible') stopVoice();
    };
    let watchedSession: XRSession | undefined;
    const watchSession = () => {
      watchedSession?.removeEventListener('visibilitychange', visibility);
      watchedSession = this.world.xrSession;
      watchedSession?.addEventListener('visibilitychange', visibility);
    };
    this.xrManager.addEventListener('sessionstart', watchSession);
    watchSession();
    // --- MR mode: hide the gradient sky dome in immersive-ar so the
    // passthrough feed shows through (the renderer clears transparent).
    const applyArSky = () => {
      const sessionMode = (this.world.xrSession as unknown as { mode?: string } | undefined)?.mode;
      const inAR = sessionMode === 'immersive-ar';
      this.world.scene.traverse((o) => {
        if (o.userData?.iwsdkSceneDomeGradient) o.visible = !inAR;
      });
    };
    this.xrManager.addEventListener('sessionstart', applyArSky);
    this.xrManager.addEventListener('sessionend', applyArSky);
    applyArSky();
    const pageHidden = () => {
      if (document.visibilityState === 'hidden') { stopVoice(); this.composer.keyboard.close(); }
    };
    const pageGone = () => { stopVoice(); this.composer.keyboard.close(); };
    document.addEventListener?.('visibilitychange', pageHidden);
    globalThis.addEventListener?.('pagehide', pageGone);
    this.cleanupFuncs.push(() => {
      document.removeEventListener?.('visibilitychange', pageHidden);
      globalThis.removeEventListener?.('pagehide', pageGone);
      this.xrManager.removeEventListener('sessionend', sessionEnd);
      this.xrManager.removeEventListener('sessionstart', watchSession);
      this.xrManager.removeEventListener('sessionstart', applyArSky);
      this.xrManager.removeEventListener('sessionend', applyArSky);
      watchedSession?.removeEventListener('visibilitychange', visibility);
      this.composer.dispose();
    });

    // Deal the opening hand (positioned on first anchor).
    for (let s = 0; s < SLOT_COUNT; s++) this.dealIntoSlot(s);
    this.drawHud();

    this.queries.grabbed.subscribe('qualify', (e) => {
      if (this.composer.activate(e)) return;
      if (e === this.menuExitEntity) {
        this.hidePalmMenu();
        this.world.exitXR();
        return;
      }
      if (e === this.menuUndoEntity) {
        this.hidePalmMenu();
        this.undoLastAction();
        return;
      }
      if (e === this.menuHelpEntity) {
        this.hidePalmMenu();
        this.showHint();
        return;
      }
      if (e === this.undoEntity) {
        this.undoLastAction();
        return;
      }
      if (e === this.replyEntity || e === this.forwardEntity) {
        this.composeSelection(e === this.replyEntity ? 'reply' : 'forward');
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
    this.placeLocal(this.menuMeshes[0], -MENU_SPREAD, MENU_Y_OFF, MENU_DIST, true);
    this.placeLocal(this.menuMeshes[1], 0, MENU_Y_OFF, MENU_DIST, true);
    this.placeLocal(this.menuMeshes[2], MENU_SPREAD, MENU_Y_OFF, MENU_DIST, true);

    this.placeLocal(this.undoMesh, 0, UNDO_Y_OFF, UNDO_DIST, true);
    this.placeLocal(this.replyMesh, -0.43, UNDO_Y_OFF, UNDO_DIST, true);
    this.placeLocal(this.forwardMesh, 0.43, UNDO_Y_OFF, UNDO_DIST, true);
    this.placeLocal(this.selectionMesh, 0, -0.82, 0.9, true);
    if (this.mail.draft) this.composer.reanchor();

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

  /** World pose (position + player-facing orientation) of an arc slot. */
  private slotPose(slot: number, outPos: Vector3, outQuat: Quaternion): void {
    const t = SLOT_COUNT === 1 ? 0 : slot / (SLOT_COUNT - 1); // 0..1
    const x = (t - 0.5) * 2 * SLOT_SPREAD;
    const dist = SLOT_DIST + 0.15 * Math.pow(x / SLOT_SPREAD, 2); // gentle arc
    outPos.set(x, 0, -dist).applyQuaternion(this.anchorYawQ);
    outPos.add(this.anchorPos);
    outPos.y = this.anchorPos.y + SLOT_Y_OFF;
    // Face the player (plane +Z toward the head).
    this.tmpObj.position.copy(outPos);
    this.tmpObj.lookAt(this.anchorPos.x, outPos.y, this.anchorPos.z);
    outQuat.copy(this.tmpObj.quaternion);
  }

  private placeCardInSlot(entity: Entity, slot: number): void {
    const rt = this.runtime.get(entity);
    if (!rt) return;
    this.slotPose(slot, this.tmpB, this.tmpQ);
    rt.root.position.copy(this.tmpB);
    rt.root.quaternion.copy(this.tmpQ);
    const home = entity.getVectorView(EmailCard, 'homePosition');
    home[0] = this.tmpB.x;
    home[1] = this.tmpB.y;
    home[2] = this.tmpB.z;
  }

  /**
   * Rotate every queued card one slot in the swipe direction, wrapping around
   * the arc. Cards glide to their new slots via the Returning state; inbox
   * membership, slot refill and undo history are untouched — a palm spin only
   * rearranges.
   */
  private spinCarousel(direction: 1 | -1): void {
    const moves: { entity: Entity; slot: number }[] = [];
    for (let s = 0; s < SLOT_COUNT; s++) {
      const entity = this.slots[s];
      if (!entity || entity.getValue(EmailCard, 'state') !== CardState.Queued) continue;
      moves.push({ entity, slot: (s + direction + SLOT_COUNT) % SLOT_COUNT });
    }
    if (moves.length === 0) return;
    for (const { entity, slot } of moves) {
      const rt = this.runtime.get(entity);
      if (!rt) continue;
      this.slotPose(slot, this.tmpB, this.tmpQ);
      const home = entity.getVectorView(EmailCard, 'homePosition');
      home[0] = this.tmpB.x;
      home[1] = this.tmpB.y;
      home[2] = this.tmpB.z;
      rt.returnQuat = new Quaternion().copy(this.tmpQ);
      entity.setValue(EmailCard, 'slotIndex', slot);
      entity.setValue(EmailCard, 'state', CardState.Returning);
      this.slots[slot] = entity;
    }
  }

  // ------------------------------------------------------------------ setup

  private dealIntoSlot(slot: number, emailIndex = this.queue.shift()): void {
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
      swipe: new SwipeTracker(),
      dismissT: -1,
      dismissVel: new Vector3(),
      dismissSlot: -1,
      returnQuat: null,
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

  private buildPalmMenu(): void {
    const button = (label: string, sub: string, color: string): [Mesh, Entity] => {
      const mesh = makeLabelPlane(label, 0.3, { fontPx: 84, color, sub });
      const entity = this.world.createTransformEntity(mesh);
      entity.addComponent(OneHandGrabbable, { rotate: false, translate: false });
      entity.addComponent(RayInteractable);
      mesh.pointerEventsType = { allow: ['grab', 'ray'] };
      mesh.visible = false;
      mesh.pointerEvents = 'none';
      this.menuMeshes.push(mesh);
      return [mesh, entity];
    };
    [, this.menuExitEntity] = button('EXIT', 'leave VR', '#ff8080');
    [, this.menuUndoEntity] = button('UNDO', 'restore last', '#aaccff');
    [, this.menuHelpEntity] = button('HELP', 'how to play', '#cfe0ff');
  }

  private showPalmMenu(): void {
    if (this.menuVisible) return;
    this.menuVisible = true;
    this.menuHoldT = 0;
    this.menuHideT = 0;
    // Mirror the persistent UNDO button's enabled state on the menu copy.
    (this.menuMeshes[1].material as MeshBasicMaterial).opacity = this.canUndo() ? 1 : 0.35;
    for (const mesh of this.menuMeshes) {
      mesh.visible = true;
      mesh.pointerEvents = 'auto';
    }
  }

  private hidePalmMenu(): void {
    if (!this.menuVisible) return;
    this.menuVisible = false;
    this.menuHoldT = 0;
    this.menuHideT = 0;
    for (const mesh of this.menuMeshes) {
      mesh.visible = false;
      mesh.pointerEvents = 'none';
    }
  }

  private showHint(): void {
    this.hintHidden = false;
    this.hintMesh.visible = true;
  }

  private buildUndo(): void {
    this.undoMesh = makeLabelPlane('UNDO', 0.36, {
      fontPx: 96,
      color: '#aaccff',
      sub: 'pinch to restore',
    });
    this.undoEntity = this.world.createTransformEntity(this.undoMesh);
    this.undoEntity.addComponent(OneHandGrabbable, { rotate: false, translate: false });
    this.undoEntity.addComponent(RayInteractable);
    this.undoMesh.pointerEventsType = { allow: ['grab', 'ray'] };
    this.updateUndoState();
  }

  private canUndo(): boolean {
    if (!this.lastAction || this.mail.draft) return false;
    for (const entity of this.queries.cards.entities) {
      if (entity.getValue(EmailCard, 'state') === CardState.Held) return false;
    }
    return true;
  }

  private updateUndoState(): void {
    const enabled = this.canUndo();
    (this.undoMesh.material as MeshBasicMaterial).opacity = enabled ? 1 : 0.3;
    this.undoMesh.pointerEvents = enabled ? 'auto' : 'none';
  }

  private undoLastAction(): void {
    if (!this.canUndo()) return;
    const action = this.lastAction!;
    this.lastAction = null;
    const rt = action.entity ? this.runtime.get(action.entity) : undefined;
    if (rt && action.entity) {
      rt.dismissT = -1;
      rt.dismissSlot = -1;
      rt.root.pointerEvents = 'auto';
      rt.mat.opacity = 1;
      action.entity.setValue(EmailCard, 'state', CardState.Queued);
      action.entity.setValue(EmailCard, 'slotIndex', action.slot);
      this.slots[action.slot] = action.entity;
      this.placeCardInSlot(action.entity, action.slot);
    } else {
      const replacement = this.slots[action.slot];
      if (replacement) {
        this.queue.unshift(replacement.getValue(EmailCard, 'emailIndex')!);
        replacement.dispose();
      }
      this.dealIntoSlot(action.slot, action.emailIndex);
    }
    this.remaining++;
    this.mail.setAvailable(MOCK_INBOX[action.emailIndex].id, true);
    this.zeroT = -1;
    this.zeroMesh.visible = false;
    this.drawHud();
    this.updateUndoState();
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

  private buildComposeActions(): void {
    const action = (label: string): [Mesh, Entity] => {
      const mesh = makeLabelPlane(label, 0.36, {
        fontPx: 90, color: '#aaccff', sub: label === 'REPLY' ? 'or flick a card up' : 'or flick a card down',
      });
      const entity = this.world.createTransformEntity(mesh);
      entity.addComponent(OneHandGrabbable, { rotate: false, translate: false });
      entity.addComponent(RayInteractable);
      mesh.pointerEventsType = { allow: ['grab', 'ray'] };
      return [mesh, entity];
    };
    [this.replyMesh, this.replyEntity] = action('REPLY');
    [this.forwardMesh, this.forwardEntity] = action('FORWARD');
    this.selectionCanvas = document.createElement('canvas');
    this.selectionCanvas.width = 1024;
    this.selectionCanvas.height = 160;
    this.selectionTex = new CanvasTexture(this.selectionCanvas);
    this.selectionMesh = makeTexturedPlane(1.05, 1.05 * 160 / 1024, this.selectionTex);
    this.selectionMesh.pointerEvents = 'none';
    this.world.createTransformEntity(this.selectionMesh);
    this.cleanupFuncs.push(this.mail.subscribe(() => {
      const open = !!this.mail.draft;
      if (this.draftWasOpen && !open) this.composeFeedbackUntil = this.elapsed + 8;
      this.draftWasOpen = open;
      this.drawSelection();
      this.updateComposeActions();
    }));
    this.drawSelection();
    this.updateComposeActions();
  }

  private drawSelection(): void {
    const ctx = this.selectionCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, 1024, 160);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#cfe0ff';
    ctx.font = '600 40px system-ui, sans-serif';
    const selected = this.mail.selected;
    const feedback = this.elapsed < this.composeFeedbackUntil;
    ctx.fillText(feedback ? this.mail.status : selected ? `Selected: ${selected.sender}` : 'Flick ↑ reply / ↓ forward / → archive / ← delete', 512, 58, 1000);
    ctx.font = '400 34px system-ui, sans-serif';
    ctx.fillText(feedback ? 'Sample only • no email delivery' : selected ? selected.subject : 'Pinch, flick, release • TODAY keeps', 512, 112, 1000);
    this.selectionTex.needsUpdate = true;
  }

  private canCompose(): boolean {
    if (!this.mail.selected || this.mail.draft) return false;
    for (const entity of this.queries.cards.entities) {
      if (entity.getValue(EmailCard, 'state') === CardState.Held) return false;
    }
    return true;
  }

  private updateComposeActions(): void {
    const enabled = this.canCompose();
    for (const mesh of [this.replyMesh, this.forwardMesh]) {
      (mesh.material as MeshBasicMaterial).opacity = enabled ? 1 : 0.3;
      mesh.pointerEvents = enabled ? 'auto' : 'none';
    }
  }

  /** XR stays active; no browser-form or custom-keyboard compose path. */
  composeSelection(mode: ComposeMode): boolean {
    if (!this.world.xrSession) return false;
    if (!this.canCompose() || !this.mail.begin(mode)) return false;
    this.composer.setXR(!!this.world.xrSession);
    return true;
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
    this.hintMesh = makeLabelPlane('Open palm, hold, sweep ← → to spin', 1.15, {
      fontPx: 56,
      color: '#cfe0ff',
      sub: '↑ reply · ↓ forward · → archive · ← delete · TODAY keeps',
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

  private updatePalmSwipes(): void {
    // Turned off 2026-10-16: the open-palm carousel sweep is disabled in
    // favor of the upcoming pinch-drag carousel. Trackers kept for reference
    // (the palm-menu summon below reuses the per-hand open-palm readers).
    if (!PALM_SWIPE_ENABLED) return;
    const session = this.world.xrSession;
    const enabled = session && session.visibilityState === 'visible' && !this.mail.draft && this.settleFrames === 0;
    // Pinches (including buttons) own input until their grab has ended.
    const holding = this.queries.grabbed.entities.size > 0;
    const frame = enabled && !holding ? this.world.xrFrame : null;
    const space = frame ? this.world.xrReferenceSpace : null;
    for (const state of this.palmHands) {
      const source = this.input.xr.getPrimaryInputSource(state.hand);
      if (source !== state.source) { state.swipe.reset(); state.source = source; continue; }
      if (!frame || !space || !source?.hand || !state.reader.read(frame, space, source.hand)) {
        state.swipe.reset();
        continue;
      }
      // The gesture is global: an open palm anywhere spins the carousel, so
      // there is no card targeting and no highlight color to maintain.
      if (this.elapsed < this.palmCooldownUntil) continue;
      this.player.localToWorld(state.reader.position);
      this.player.head.getWorldQuaternion(this.tmpQ);
      this.fwd.set(0, 0, -1).applyQuaternion(this.tmpQ);
      this.tmpQ.setFromAxisAngle(this.up, Math.atan2(-this.fwd.x, -this.fwd.z));
      const direction = state.swipe.add(state.reader.position, this.tmpQ, this.elapsed);
      if (!direction) continue;
      this.spinCarousel(direction);
      this.hideHint();
      this.palmCooldownUntil = this.elapsed + .7;
      for (const other of this.palmHands) other.swipe.reset();
      break;
    }
  }

  /**
   * Palm-menu summon: either open palm turned toward the face and held
   * still opens the EXIT / UNDO / HELP menu. Reuses the per-hand open-palm
   * readers; facing comes from hand-joint palm normals (see palm-menu.ts).
   * Tunables live in the MENU_* constants above.
   */
  private updatePalmMenu(delta: number): void {
    const session = this.world.xrSession;
    const enabled =
      session && session.visibilityState === 'visible' && !this.mail.draft && this.settleFrames === 0;
    // A grab in flight owns input: don't summon while holding, and don't
    // hide mid-pinch either — let the pinch land first.
    const holding = this.queries.grabbed.entities.size > 0;
    const frame = enabled && !holding ? this.world.xrFrame : null;
    const space = frame ? this.world.xrReferenceSpace : null;
    this.player.head.getWorldPosition(this.headPos);
    const toWorld = (v: Vector3): void => {
      this.player.localToWorld(v);
    };
    let best = -1;
    if (frame && space) {
      for (const state of this.palmHands) {
        const source = this.input.xr.getPrimaryInputSource(state.hand);
        if (!source?.hand) continue;
        if (!state.reader.read(frame, space, source.hand)) continue;
        if (!this.menuReader.read(frame, space, source.hand, state.hand, toWorld, this.headPos)) continue;
        if (this.menuReader.dist.value > MENU_HEAD_DIST_M) continue;
        best = Math.max(best, this.menuReader.facing.value);
      }
    }
    if (holding) {
      this.menuHideT = 0;
      return;
    }
    if (!this.menuVisible) {
      if (best > MENU_FACE_ON) this.menuHoldT += delta;
      else this.menuHoldT = 0;
      if (this.menuHoldT >= MENU_HOLD_S) this.showPalmMenu();
    } else {
      if (best < MENU_FACE_OFF) this.menuHideT += delta;
      else this.menuHideT = 0;
      if (this.menuHideT >= MENU_HIDE_S) this.hidePalmMenu();
    }
  }

  private onGrab(entity: Entity): void {
    const rt = this.runtime.get(entity);
    if (!rt || rt.dismissT >= 0 || this.mail.draft) return;
    this.hidePalmMenu();
    rt.lastHand = null; // Start a fresh movement window for every grab.
    entity.setValue(EmailCard, 'state', CardState.Held);
    this.mail.select(MOCK_INBOX[entity.getValue(EmailCard, 'emailIndex')!].id);
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

    rt.mat.color.setHex(0xffffff);
    const dir = rt.lastHand ? rt.swipe.getDirection(this.elapsed) : 0;
    const flick = rt.lastHand ? rt.swipe.getFlick(this.elapsed) : null;
    entity.object3D?.getWorldPosition(this.tmpA);

    if (this.mail.draft) {
      entity.setValue(EmailCard, 'state', CardState.Returning);
    } else if (this.tmpA.distanceTo(this.binPos) < BIN_RADIUS_M) {
      // An intentional drop into TODAY takes precedence over sideways motion.
      rt.dismissVel.copy(this.tmpB.copy(this.binPos).sub(this.tmpA).normalize());
      this.beginDismiss(entity, rt);
      this.hideHint();
    } else if (flick === 'up' || flick === 'down') {
      entity.setValue(EmailCard, 'state', CardState.Returning);
      this.mail.select(MOCK_INBOX[entity.getValue(EmailCard, 'emailIndex')!].id);
      this.composeSelection(flick === 'up' ? 'reply' : 'forward');
    } else if (dir) {
      rt.dismissVel.set(dir * DISMISS_SPEED, 0.7, -0.4).applyQuaternion(rt.swipe.yaw);
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
    this.lastAction = { emailIndex: entity.getValue(EmailCard, 'emailIndex')!, slot, entity };
    this.mail.setAvailable(MOCK_INBOX[this.lastAction.emailIndex].id, false);
    this.remaining = Math.max(0, this.remaining - 1);
    this.drawHud();
    this.updateUndoState();
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
    const slot = this.slots.indexOf(entity);
    if (slot >= 0) this.slots[slot] = null;
    if (this.lastAction?.entity === entity) this.lastAction.entity = null;
  }

  private hideHint(): void {
    if (!this.hintHidden) {
      this.hintHidden = true;
      this.hintMesh.visible = false;
    }
  }

  // ---------------------------------------------------------------- update

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
    this.elapsed += delta;

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
    this.composer.setXR(hasSession);
    const composing = !!this.mail.draft;
    // Keep the original in the composer; suspend background card targeting.
    for (const entity of this.queries.cards.entities) {
      const rt = this.runtime.get(entity);
      if (!rt) continue;
      rt.root.visible = !composing;
      rt.root.pointerEvents = composing || rt.dismissT >= 0 ? 'none' : 'auto';
    }
    for (const mesh of [this.binMesh, this.binLabel, this.undoMesh, this.replyMesh, this.forwardMesh, this.selectionMesh, this.hudMesh]) {
      mesh.visible = !composing;
    }
    for (const mesh of this.menuMeshes) {
      mesh.visible = !composing && this.menuVisible;
      mesh.pointerEvents = !composing && this.menuVisible ? 'auto' : 'none';
    }
    if (composing) this.hidePalmMenu();
    this.hintMesh.visible = !composing && !this.hintHidden;
    if (composing) this.zeroMesh.visible = false;
    if (this.composeFeedbackUntil >= 0 && this.elapsed >= this.composeFeedbackUntil) {
      this.composeFeedbackUntil = -1;
      this.drawSelection();
    }

    // Track only held cards, measuring sideways relative to facing at grab.
    if (this.grab) {
      for (const entity of this.queries.grabbed.entities) {
        const rt = this.runtime.get(entity);
        if (!rt || rt.dismissT >= 0) continue;
        const hand = this.grab.getHolderHand(entity);
        if (!hand) continue;
        this.player.gripSpaces[hand].getWorldPosition(this.tmpA);
        if (rt.lastHand !== hand) {
          this.player.head.getWorldQuaternion(this.tmpQ);
          this.fwd.set(0, 0, -1).applyQuaternion(this.tmpQ);
          this.tmpQ.setFromAxisAngle(this.up, Math.atan2(-this.fwd.x, -this.fwd.z));
          rt.swipe.reset(this.tmpA, this.tmpQ, this.elapsed);
          rt.lastHand = hand;
        } else {
          rt.swipe.add(this.tmpA, this.elapsed);
        }
        const flick = rt.swipe.getFlick(this.elapsed);
        rt.mat.color.setHex(flick === 'right' ? 0xaaffcc : flick === 'left' ? 0xffaaaa : flick === 'up' ? 0xaacfff : flick === 'down' ? 0xe3b0ff : 0xffffff);
      }
    }
    this.updateUndoState();

    this.updatePalmSwipes();
    this.updatePalmMenu(delta);
    this.updateComposeActions();

    // 3. Card state machines.
    for (const entity of this.queries.cards.entities) {
      const rt = this.runtime.get(entity);
      if (!rt) continue;
      const state = entity.getValue(EmailCard, 'state');

      if (state === CardState.Returning) {
        const home = entity.getVectorView(EmailCard, 'homePosition');
        this.tmpA.set(home[0], home[1], home[2]);
        const mesh = rt.root;
        const k = Math.min(1, RETURN_LERP * delta);
        mesh.position.lerp(this.tmpA, k);
        // Carousel spins also rotate the card to face the player from its new slot.
        if (rt.returnQuat) mesh.quaternion.slerp(rt.returnQuat, k);
        if (mesh.position.distanceToSquared(this.tmpA) < 1e-6) {
          mesh.position.copy(this.tmpA);
          if (rt.returnQuat) {
            mesh.quaternion.copy(rt.returnQuat);
            rt.returnQuat = null;
          }
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
