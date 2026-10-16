import { CanvasTexture, Group, Mesh, MeshBasicMaterial, OneHandGrabbable, PlaneGeometry, RayInteractable, Quaternion, Vector3 } from '@iwsdk/core';
import type { Entity, World } from '@iwsdk/core';
import { SystemKeyboard } from './system-keyboard.js';
import { DraftEditor } from './draft-editor.js';
import type { DraftField } from './draft-editor.js';
import type { Draft, SampleMail } from './sample-mail.js';

interface Surface { mesh: Mesh; canvas: HTMLCanvasElement; texture: CanvasTexture; entity: Entity; lastPaint?: string; }
interface Button extends Surface { entity: Entity; label: string; action: () => void; }

/** All interaction surfaces are real IWSDK near/ray targets, not DOM overlays. */
export class ImmersiveComposer {
  readonly root = new Group();
  readonly editor: DraftEditor;
  readonly keyboard: SystemKeyboard;
  private keyboardMode: 'append' | 'replace' = 'append';
  private inputMode: 'voice' | 'keyboard' = 'voice';
  readonly buttons: Button[] = [];
  private rootEntity: Entity;
  private surfaces: Surface[] = [];
  private actions = new Map<Entity, Button>();
  private fields = new Map<DraftField, Surface>();
  private original: Surface;
  private heading: Surface;
  private status: Surface;
  private voiceHelp: Surface;
  private page = 0;
  private pageCount = 1;
  private messageStart: number | null = null;
  private renderedMessageStart = 0;
  private messageLines = 0;
  private lastMessage = '';
  private unsubscribe: () => void;
  private xr = false;
  private wasOpen = false;
  private keyboardDraft: Draft | null = null;
  private sourceId = '';
  private head = new Vector3();
  private rotation = new Quaternion();
  private forward = new Vector3();
  private up = new Vector3(0, 1, 0);
  constructor(private world: World, readonly mail: SampleMail) {
    this.root.name = 'Immersive email composer';
    this.root.visible = false;
    this.root.pointerEvents = 'none';
    this.rootEntity = world.createTransformEntity(this.root);
    this.editor = new DraftEditor(mail, () => this.render());
    this.keyboard = new SystemKeyboard(() => this.render());
    this.heading = this.surface(1.05, .13, .29, .55);
    this.button('← Back', -.57, .70, .56, () => {
      this.keyboard.close(); this.editor.voice.abort(); this.mail.back();
    });
    this.original = this.surface(.56, .80, -.57, .21);
    this.button('Earlier', -.72, -.245, .23, () => { this.page = Math.max(0, this.page - 1); this.render(); });
    this.button('Later', -.42, -.245, .23, () => { this.page = Math.min(this.pageCount - 1, this.page + 1); this.render(); });
    this.button('Message ↑', -.72, -.345, .26, () => {
      this.messageStart = Math.max(0, this.renderedMessageStart - 5); this.render();
    });
    this.button('Message ↓', -.42, -.345, .26, () => {
      this.messageStart = Math.min(Math.max(0, this.messageLines - 5), this.renderedMessageStart + 5); this.render();
    });
    for (const [field, y, h] of [['to', .385, .10], ['subject', .255, .10], ['message', .045, .28]] as const) {
      const button = this.button(field, .29, y, 1.05, () => { this.keyboard.close(); this.editor.focus(field); this.keyboardMode = 'append'; this.render(); }, h);
      this.fields.set(field, button);
    }
    this.status = this.surface(1.05, .14, .29, -.19);
    this.button('Record', -.065, -.315, .32, () => {
      this.keyboard.close(); this.inputMode = 'voice'; this.editor.record();
    });
    this.button('Horizon keyboard', .485, -.315, .66, () => this.openKeyboard());
    this.button('Add / Replace', -.025, -.415, .40, () => {
      this.keyboard.close();
      this.keyboardMode = this.keyboardMode === 'append' ? 'replace' : 'append';
      this.render();
    });
    this.button('Undo edit', .385, -.415, .32, () => { this.keyboard.close(); this.editor.undoEdit(); });
    this.button('Paragraph', .695, -.415, .25, () => { this.keyboard.close(); this.editor.newParagraph(); });
    this.voiceHelp = this.surface(1.05, .28, .29, -.615);
    this.button('Simulate send', .08, -.825, .50, () => { this.keyboard.close(); this.editor.send(); });
    this.button('Cancel', .625, -.825, .32, () => { this.keyboard.close(); this.editor.cancel(); });
    this.unsubscribe = mail.subscribe(() => {
      if (!mail.draft) { this.keyboardDraft = null; this.keyboard.close(); this.keyboardMode = 'append'; this.inputMode = 'voice'; }
      this.render();
    });
    this.render();
  }
  private surface(w: number, h: number, x: number, y: number): Surface {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * 1000);
    canvas.height = Math.round(h * 1000);
    const texture = new CanvasTexture(canvas);
    const mesh = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ map: texture, transparent: true }));
    mesh.position.set(x, y, 0);
    mesh.pointerEvents = 'none';
    const entity = this.world.createTransformEntity(mesh, this.rootEntity);
    const surface = { mesh, canvas, texture, entity };
    this.surfaces.push(surface);
    return surface;
  }
  private button(label: string, x: number, y: number, width: number, action: () => void, height = .070): Button {
    const surface = this.surface(width, height, x, y);
    const entity = surface.entity;
    entity.addComponent(OneHandGrabbable, { rotate: false, translate: false });
    entity.addComponent(RayInteractable);
    surface.mesh.pointerEventsType = { allow: ['grab', 'ray'] };
    const button = { ...surface, entity, label, action };
    surface.mesh.name = `Composer: ${label}`;
    this.buttons.push(button);
    this.actions.set(entity, button);
    return button;
  }
  /** Qualify edges give exactly one activation per pinch, including native hands. */
  activate(entity: Entity): boolean {
    const button = this.actions.get(entity);
    if (!button) return false;
    const visibility = this.world.xrSession?.visibilityState;
    if (this.root.visible && (!visibility || visibility === 'visible') && button.mesh.visible && button.mesh.pointerEvents === 'auto') button.action();
    return true;
  }
  setXR(active: boolean): void {
    this.keyboard.setSession(active ? this.world.xrSession : undefined);
    if (active !== this.xr) {
      this.xr = active;
      if (!active) { this.keyboardDraft = null; this.editor.voice.abort(); }
      this.render();
    }
    // Request once on entry, never again on input, frame updates or dismissal.
    if (active && this.mail.draft && this.keyboardDraft !== this.mail.draft) {
      this.keyboardDraft = this.mail.draft;
      this.openKeyboard();
    }
  }
  private openKeyboard(): void {
    this.inputMode = 'keyboard';
    this.keyboard.open(this.editor.field, this.editor.beginKeyboard(this.keyboardMode));
  }
  reanchor(): void {
    this.world.player.head.getWorldPosition(this.head);
    this.world.player.head.getWorldQuaternion(this.rotation);
    this.forward.set(0, 0, -1).applyQuaternion(this.rotation);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.rotation.setFromAxisAngle(this.up, Math.atan2(-this.forward.x, -this.forward.z));
    this.root.quaternion.copy(this.rotation);
    this.root.position.set(0, -.02, -1.2).applyQuaternion(this.rotation).add(this.head);
  }
  private paint(surface: Surface, lines: string[], opts: { font?: number; color?: string; background?: string; border?: string } = {}): void {
    const signature = JSON.stringify([lines, opts]);
    if (signature === surface.lastPaint) return;
    surface.lastPaint = signature;
    const { canvas, texture } = surface;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = opts.background ?? '#101c32';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = opts.border ?? '#5774a1';
    ctx.lineWidth = 3;
    ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
    const font = opts.font ?? 27;
    ctx.font = `500 ${font}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillStyle = opts.color ?? '#f0f5ff';
    lines.forEach((line, i) => ctx.fillText(line, 15, font + 10 + i * (font + 8)));
    texture.needsUpdate = true;
  }
  private lines(surface: Surface, text: string, font = 27): string[] {
    const ctx = surface.canvas.getContext('2d')!;
    ctx.font = `500 ${font}px system-ui, sans-serif`;
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const word of paragraph.match(/\S+\s*|\s+/g) ?? []) {
        if (line && ctx.measureText(line + word.trimEnd()).width > surface.canvas.width - 30) {
          lines.push(line.trimEnd());
          line = '';
        }
        // Long addresses/words must still fit, without clipping their caret.
        for (const char of word) {
          if (line && ctx.measureText(line + char).width > surface.canvas.width - 30) {
            lines.push(line.trimEnd()); line = '';
          }
          line += char;
        }
      }
      lines.push(line);
    }
    return lines;
  }
  render(): void {
    // Constructor callbacks can precede surface creation.
    if (!this.heading) return;
    const draft = this.mail.draft;
    const open = this.xr && !!draft;
    this.root.visible = open;
    this.root.pointerEvents = open ? 'auto' : 'none';
    if (open && !this.wasOpen) this.reanchor();
    this.wasOpen = open;
    if (!draft) return;
    if (draft.message !== this.lastMessage) { this.lastMessage = draft.message; this.messageStart = null; }
    if (this.sourceId !== draft.source.id) { this.sourceId = draft.source.id; this.page = 0; }
    this.paint(this.heading, [draft.mode === 'reply' ? 'REPLY • voice or keyboard' : 'FORWARD • voice or keyboard', 'Sample only — Simulate send saves here. No email delivery.'], { font: 30 });
    const original = this.lines(this.original, `ORIGINAL • ${draft.source.sender}\n${draft.source.subject}\n\n${draft.source.body}`, 28);
    this.pageCount = Math.max(1, Math.ceil(original.length / 18));
    this.paint(this.original, [...original.slice(this.page * 18, (this.page + 1) * 18), `(${this.page + 1}/${this.pageCount}) Original included on send`], { font: 28 });
    for (const [field, surface] of this.fields) {
      const active = field === this.editor.field;
      const chars = Array.from(draft[field]);
      if (active) chars.splice(this.editor.cursor, 0, '│');
      const label = field === 'to' ? `To${draft.mode === 'reply' ? ' (sample sender)' : ''}` : field === 'subject' ? 'Subject' : 'Message';
      const content = this.lines(surface, chars.join('') || 'Select to edit', 28);
      const caretLine = Math.max(0, content.findIndex((line) => line.includes('│')));
      const maxLines = field === 'message' ? 5 : 1;
      const start = field === 'message' && this.messageStart !== null
        ? this.messageStart : active ? Math.max(0, caretLine - maxLines + 1) : 0;
      if (field === 'message') { this.renderedMessageStart = start; this.messageLines = content.length; }
      this.paint(surface, [label + (active ? ' • editing' : ''), ...content.slice(start, start + maxLines)], { font: 28, border: active ? '#89e7ba' : '#5774a1' });
    }
    const voice = this.editor.voice;
    const inputStatus = this.inputMode === 'keyboard' ? this.keyboard.status : voice.status;
    this.paint(this.status, this.lines(this.status, `${this.editor.error || inputStatus}\nBrowser speech may send audio to its provider.${voice.interim ? `\nHearing: ${voice.interim}` : ''}`, 25).slice(0, 4), { font: 25, color: this.editor.error ? '#ffb4b4' : voice.active ? '#ffcd93' : '#a9eec6' });
    this.paint(this.voiceHelp, this.lines(this.voiceHelp,
      `${voice.supported ? 'Select Record to dictate, or Horizon keyboard to type.' : 'Browser voice is unavailable. Use Horizon keyboard if supported.'}\nSelect To, Subject, or Message first. Keyboard mode: ${this.keyboardMode === 'append' ? 'ADD text (keeps existing text)' : 'REPLACE field (first input replaces it)'}.\nThe system keyboard starts a fresh edit each time. Undo edit restores the prior field.\n${this.keyboard.supported ? 'Dismiss the system keyboard to review and Simulate send.' : 'This XR session does not expose the Horizon system keyboard.'}\nNo recording starts automatically. Stop and review before sending.`, 27), { font: 27 });
    for (const button of this.buttons) {
      button.mesh.visible = true;
      const field = ['to', 'subject', 'message'].includes(button.label);
      let enabled = open && button.mesh.visible;
      if (button.label === 'Paragraph' && this.editor.field !== 'message') enabled = false;
      if (button.label === 'Record' && !voice.supported) enabled = false;
      if (button.label === 'Simulate send' && (voice.active || this.keyboard.active)) enabled = false;
      if (button.label === 'to' && draft.mode === 'reply') enabled = false;
      button.mesh.pointerEvents = enabled ? 'auto' : 'none';
      (button.mesh.material as MeshBasicMaterial).opacity = enabled || field ? 1 : .4;
      if (!field) {
        const label = button.label === 'Record' ? voice.active ? 'Stop mic' : voice.supported ? 'Record' : 'No voice API'
          : button.label === 'Add / Replace' ? this.keyboardMode === 'append' ? 'Mode: Add text' : 'Mode: Replace field'
          : button.label;
        this.paint(button, [label], { font: button.label.length > 5 ? 24 : 29, background: button.label === 'Record' && voice.active ? '#85352e' : '#233d62' });
      }
    }
  }
  dispose(): void {
    this.unsubscribe();
    this.editor.dispose();
    this.keyboard.dispose();
    this.rootEntity.dispose();
  }
}
