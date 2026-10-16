import { Dictation } from './dictation.js';
import type { RecognitionFactory } from './dictation.js';
import type { Draft, SampleMail } from './sample-mail.js';

export type DraftField = 'to' | 'subject' | 'message';
/** Voice and native-keyboard edits, with one undo checkpoint per keyboard session. */
export class DraftEditor {
  field: DraftField = 'message';
  cursor = 0;
  error = '';
  readonly voice: Dictation;
  private current: Draft | null = null;
  private unsubscribe: () => void;
  private history: { field: DraftField; value: string; cursor: number }[] = [];
  constructor(readonly mail: SampleMail, private changed: () => void, factory?: RecognitionFactory) {
    this.voice = new Dictation((text) => {
      if (!this.mail.draft || this.mail.draft !== this.current) return;
      const before = Array.from(this.value).slice(0, this.cursor).join('');
      // Address dictation is literal; the keyboard can correct spaces and punctuation.
      this.insert(`${before && !/\s$/.test(before) ? ' ' : ''}${text}`);
    }, changed, factory);
    this.unsubscribe = mail.subscribe(() => {
      if (mail.draft !== this.current) {
        this.current = mail.draft;
        this.voice.abort();
        this.field = mail.draft?.mode === 'forward' ? 'to' : 'message';
        this.cursor = Array.from(this.value).length;
        this.error = '';
        this.history = [];
      }
      this.cursor = Math.min(this.cursor, Array.from(this.value).length);
      this.changed();
    });
  }
  get value(): string { return this.mail.draft?.[this.field] ?? ''; }
  focus(field: DraftField): void {
    if (!this.mail.draft || (field === 'to' && this.mail.draft.mode === 'reply')) return;
    this.voice.abort();
    this.field = field;
    this.cursor = Array.from(this.value).length;
    this.error = '';
    this.changed();
  }
  private replace(value: string, cursor: number): void {
    if (!this.mail.draft || (this.field === 'to' && this.mail.draft.mode === 'reply')) return;
    this.history.push({ field: this.field, value: this.value, cursor: this.cursor });
    if (this.history.length > 100) this.history.shift();
    this.cursor = cursor;
    this.error = '';
    this.mail.edit({ [this.field]: value });
  }
  insert(text: string): void {
    const chars = Array.from(this.value);
    chars.splice(this.cursor, 0, ...Array.from(text));
    this.replace(chars.join(''), this.cursor + Array.from(text).length);
  }
  beginKeyboard(mode: 'append' | 'replace'): (text: string) => void {
    this.voice.abort();
    this.error = '';
    const draft = this.mail.draft;
    const field = this.field;
    const original = this.value;
    let checkpointed = false;
    return (text) => {
      if (!draft || this.mail.draft !== draft || this.field !== field) return;
      if (field === 'to' && draft.mode === 'reply') return;
      if (!checkpointed) {
        this.history.push({ field, value: original, cursor: this.cursor });
        if (this.history.length > 100) this.history.shift();
        checkpointed = true;
      }
      const separator = field !== 'to' && original && text && !/\s$/.test(original) ? ' ' : '';
      const value = mode === 'replace' ? text : original + separator + text;
      this.cursor = Array.from(value).length;
      this.mail.edit({ [field]: value });
    };
  }
  undoEdit(): void {
    this.voice.abort();
    const previous = this.history.pop();
    if (previous && this.mail.draft) {
      this.field = previous.field;
      this.cursor = previous.cursor;
      this.mail.edit({ [previous.field]: previous.value });
    }
    this.error = '';
    this.changed();
  }
  newParagraph(): void {
    if (this.field !== 'message') return;
    this.voice.abort();
    this.cursor = Array.from(this.value).length;
    this.insert('\n\n');
  }
  record(): void {
    if (!this.mail.draft) return;
    this.error = '';
    if (this.voice.active) this.voice.stop();
    else this.voice.start();
    this.changed();
  }
  send(): void {
    if (this.voice.active) { this.error = 'Stop recording and review the text before sending.'; this.changed(); return; }
    this.voice.abort();
    const problem = this.mail.send();
    if (problem) { this.focus(problem.field); this.error = problem.message; this.changed(); }
  }
  cancel(): void { this.voice.abort(); this.mail.cancel(); }
  dispose(): void { this.unsubscribe(); this.voice.abort(); }
}
