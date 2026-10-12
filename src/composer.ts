/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Immersive composer for Triage — reply and forward.
 *
 * Visual language matches the email cards exactly: dark navy rounded panel
 * (rgba(16, 22, 40, 0.94)), blue glow border, left accent bar, system-ui
 * type. The composer is a spatial panel anchored in front of the player,
 * not a flat overlay — it belongs in the world with the cards.
 *
 * Interaction is all pinch (bare hands via GrabSystem):
 *   - Pinch DICTATE to toggle voice recording (MediaRecorder → Whisper
 *     on the Mac mini, same /transcribe endpoint as the Quest voice app).
 *   - Pinch SEND to send (mock — Gmail wires up later).
 *   - Pinch DISCARD to close without sending.
 *
 * The original email stays visible as a quoted header so the player never
 * loses context while composing.
 */

import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  OneHandGrabbable,
  PlaneGeometry,
  Vector3,
} from '@iwsdk/core';
import type { Entity, World } from '@iwsdk/core';
import type { Email } from './mockInbox.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// Composer panel size (meters) — taller than a card, readable at arm's length.
const PANEL_W = 0.52;
const PANEL_H = 0.68;

export type ComposeMode = 'reply' | 'forward';

interface ComposerCallbacks {
  onSend: (mode: ComposeMode, email: Email, body: string) => void;
  onDiscard: () => void;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export class ImmersiveComposer {
  private world: World;
  private cb: ComposerCallbacks;
  private mode: ComposeMode = 'reply';
  private email: Email | null = null;
  private body = '';
  private recording = false;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  private root!: Mesh;
  private tex!: CanvasTexture;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private entities: Entity[] = [];
  private visible = false;

  // Button entities (pinch to press).
  private dictateBtn: Entity | null = null;
  private sendBtn: Entity | null = null;
  private discardBtn: Entity | null = null;

  constructor(world: World, cb: ComposerCallbacks) {
    this.world = world;
    this.cb = cb;
    this.buildPanel();
  }

  private buildPanel(): void {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 720;
    this.canvas.height = 940;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new CanvasTexture(this.canvas);
    this.tex.anisotropy = 4;
    const mat = new MeshBasicMaterial({ map: this.tex, transparent: true });
    this.root = new Mesh(new PlaneGeometry(PANEL_W, PANEL_H), mat);
    this.root.visible = false;
    this.world.createTransformEntity(this.root);

    // Buttons are small pinchable planes below the panel.
    this.dictateBtn = this.makeButton('🎤 Dictate', '#7aa2ff', () =>
      this.toggleDictate(),
    );
    this.sendBtn = this.makeButton('Send', '#7dffb0', () => this.send());
    this.discardBtn = this.makeButton('Discard', '#ff8080', () =>
      this.discard(),
    );
    this.layoutButtons();
  }

  private makeButton(
    label: string,
    color: string,
    onPress: () => void,
  ): Entity {
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 120;
    const ctx = canvas.getContext('2d')!;
    roundRect(ctx, 4, 4, 352, 112, 28);
    ctx.fillStyle = 'rgba(16, 22, 40, 0.94)';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = `700 44px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(label, 180, 76);
    const tex = new CanvasTexture(canvas);
    tex.anisotropy = 4;
    const mesh = new Mesh(
      new PlaneGeometry(0.22, 0.073),
      new MeshBasicMaterial({ map: tex, transparent: true }),
    );
    mesh.visible = false;
    const entity = this.world.createTransformEntity(mesh);
    entity.addComponent(OneHandGrabbable, { rotate: false });
    // Store the press handler on the entity for the triage system to call.
    (entity as unknown as { _onPress: () => void })._onPress = onPress;
    this.entities.push(entity);
    return entity;
  }

  private layoutButtons(): void {
    // Positioned relative to the panel; updated in place().
    // dictate | send | discard in a row below the panel.
  }

  /** Show the composer for an email, anchored in front of the player. */
  open(
    mode: ComposeMode,
    email: Email,
    anchorPos: Vector3,
    anchorYawQ: { x: number; y: number; z: number; w: number },
  ): void {
    this.mode = mode;
    this.email = email;
    this.body = '';
    this.visible = true;
    this.root.visible = true;
    this.draw();

    // Place the panel 0.75m in front of the player, at chest height.
    const yawQ = anchorYawQ as unknown as import('@iwsdk/core').Quaternion;
    const offset = new Vector3(0, -0.05, -0.75).applyQuaternion(yawQ);
    this.root.position.copy(anchorPos).add(offset);
    this.root.position.y = anchorPos.y - 0.05;
    this.root.lookAt(anchorPos.x, this.root.position.y, anchorPos.z);

    // Buttons in a row below the panel.
    const btnY = this.root.position.y - PANEL_H / 2 - 0.07;
    const positions = [-0.16, 0, 0.16];
    [this.dictateBtn, this.sendBtn, this.discardBtn].forEach((btn, i) => {
      if (!btn) return;
      const mesh = btn.object3D as Mesh;
      mesh.visible = true;
      const bx = new Vector3(positions[i], 0, 0).applyQuaternion(yawQ);
      mesh.position.copy(this.root.position).add(bx);
      mesh.position.y = btnY;
      mesh.lookAt(anchorPos.x, btnY, anchorPos.z);
    });
  }

  close(): void {
    this.visible = false;
    this.root.visible = false;
    this.stopRecording();
    for (const e of this.entities) {
      const mesh = e.object3D as Mesh;
      mesh.visible = false;
    }
  }

  get isOpen(): boolean {
    return this.visible;
  }

  /** Route a pinched entity to its button handler, if it's one of ours. */
  handlePinch(entity: Entity): boolean {
    const handler = (entity as unknown as { _onPress?: () => void })._onPress;
    if (handler && this.visible) {
      handler();
      return true;
    }
    return false;
  }

  private draw(): void {
    const ctx = this.ctx;
    const W = 720;
    const H = 940;
    ctx.clearRect(0, 0, W, H);

    // Panel base — same as cards.
    roundRect(ctx, 4, 4, W - 8, H - 8, 36);
    ctx.fillStyle = 'rgba(16, 22, 40, 0.94)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 160, 255, 0.55)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Accent bar: green for reply, blue for forward.
    const accent = this.mode === 'reply' ? '#7dffb0' : '#7aa2ff';
    ctx.fillStyle = accent;
    roundRect(ctx, 4, 4, 18, H - 8, 9);
    ctx.fill();

    const pad = 64;
    const textW = W - pad * 2 - 24;

    // Header.
    ctx.fillStyle = accent;
    ctx.font = `700 36px ${FONT}`;
    ctx.fillText(
      this.mode === 'reply' ? 'REPLY' : 'FORWARD',
      pad + 24,
      92,
    );

    if (!this.email) return;

    // Quoted original.
    ctx.fillStyle = '#9db4ff';
    ctx.font = `600 28px ${FONT}`;
    const prefix =
      this.mode === 'reply'
        ? `To: ${this.email.sender}`
        : 'To: (choose recipient)';
    ctx.fillText(prefix.toUpperCase(), pad + 24, 140);

    ctx.fillStyle = '#ffffff';
    ctx.font = `700 34px ${FONT}`;
    const subj =
      this.mode === 'reply'
        ? `Re: ${this.email.subject}`
        : `Fwd: ${this.email.subject}`;
    wrap(ctx, subj, textW)
      .slice(0, 2)
      .forEach((ln, i) => ctx.fillText(ln, pad + 24, 188 + i * 44));

    // Divider.
    ctx.strokeStyle = 'rgba(120, 160, 255, 0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pad + 24, 280);
    ctx.lineTo(W - pad - 24, 280);
    ctx.stroke();

    // Dictated body.
    ctx.fillStyle = 'rgba(230, 238, 255, 0.92)';
    ctx.font = `400 32px ${FONT}`;
    const bodyText = this.body || (this.recording ? '● listening…' : '(pinch Dictate and speak)');
    wrap(ctx, bodyText, textW)
      .slice(0, 12)
      .forEach((ln, i) => ctx.fillText(ln, pad + 24, 340 + i * 46));

    // Recording indicator.
    if (this.recording) {
      ctx.fillStyle = '#ff8080';
      ctx.beginPath();
      ctx.arc(W - 80, 80, 18, 0, Math.PI * 2);
      ctx.fill();
    }

    this.tex.needsUpdate = true;
  }

  private async toggleDictate(): Promise<void> {
    if (this.recording) {
      this.stopRecording();
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.body = '(microphone unavailable)';
      this.draw();
      return;
    }
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onstop = () => this.transcribe();
    this.recorder.start();
    this.recording = true;
    this.draw();
  }

  private stopRecording(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recording = false;
  }

  private async transcribe(): Promise<void> {
    this.stopRecording();
    if (this.chunks.length === 0) {
      this.draw();
      return;
    }
    const blob = new Blob(this.chunks, { type: 'audio/webm' });
    try {
      // Same-origin Whisper endpoint on the mini (port 4444 server).
      // In the Triage dev context this may not exist — fail gracefully.
      const res = await fetch('/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/webm' },
        body: blob,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { text?: string };
      const text = (data.text || '').trim();
      if (text) {
        this.body = this.body ? `${this.body} ${text}` : text;
      }
    } catch {
      // Transcription unavailable — player can still use the mock body.
      if (!this.body) this.body = '(dictation unavailable)';
    }
    this.draw();
  }

  private send(): void {
    if (this.email) {
      this.cb.onSend(this.mode, this.email, this.body);
    }
    this.close();
  }

  private discard(): void {
    this.cb.onDiscard();
    this.close();
  }

  dispose(): void {
    this.stopRecording();
    this.close();
  }
}
