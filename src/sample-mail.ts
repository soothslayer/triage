import type { Email } from './mockInbox.js';

export type ComposeMode = 'reply' | 'forward';
export interface Draft {
  mode: ComposeMode;
  source: Email;
  to: string;
  subject: string;
  message: string;
}
export interface SampleSentMessage {
  mode: ComposeMode;
  sourceId: string;
  to: string;
  subject: string;
  body: string;
}

/** Session-only sample mailbox. Deliberately has no transport or persistence. */
export class SampleMail {
  selectedId: string | null = null;
  draft: Draft | null = null;
  readonly sent: SampleSentMessage[] = [];
  status = 'Sample inbox — nothing is sent externally.';
  private available: Set<string>;
  private savedDrafts = new Map<string, Draft>();
  private listeners = new Set<() => void>();

  constructor(readonly emails: readonly Email[]) {
    this.available = new Set(emails.map((email) => email.id));
  }

  get inbox(): readonly Email[] {
    return this.emails.filter((email) => this.available.has(email.id));
  }

  get selected(): Email | undefined {
    return this.inbox.find((email) => email.id === this.selectedId);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void {
    this.listeners.forEach((listener) => listener());
  }

  edit(patch: Partial<Pick<Draft, 'to' | 'subject' | 'message'>>): void {
    if (!this.draft) return;
    Object.assign(this.draft, patch);
    this.changed();
  }

  select(id: string): void {
    if (!this.available.has(id) || this.draft || this.selectedId === id) return;
    this.selectedId = id;
    this.changed();
  }

  setAvailable(id: string, available: boolean): void {
    if (available) this.available.add(id);
    else this.available.delete(id);
    if (!available && this.selectedId === id) this.selectedId = null;
    this.changed();
  }

  begin(mode: ComposeMode): boolean {
    const source = this.selected;
    if (!source || this.draft) return false;
    const prefix = mode === 'reply' ? 'Re:' : 'Fwd:';
    const hasPrefix = mode === 'reply' ? /^re:/i : /^(fwd|fw):/i;
    const key = `${source.id}:${mode}`;
    this.draft = this.savedDrafts.get(key) ?? {
      mode, source,
      to: mode === 'reply' ? source.senderAddress : '',
      subject: hasPrefix.test(source.subject) ? source.subject : `${prefix} ${source.subject}`,
      message: '',
    };
    this.savedDrafts.delete(key);
    this.changed();
    return true;
  }

  cancel(): void {
    if (!this.draft) return;
    this.draft = null;
    this.status = 'Draft discarded. Nothing was sent.';
    this.changed();
  }

  back(): void {
    if (!this.draft) return;
    this.savedDrafts.set(`${this.draft.source.id}:${this.draft.mode}`, this.draft);
    this.draft = null;
    this.status = 'Draft kept for this session. Open the same Reply or Forward to resume.';
    this.changed();
  }

  /** Return a field error without consuming the draft; success consumes it once. */
  send(): { field: 'to' | 'subject' | 'message'; message: string } | null {
    const draft = this.draft;
    if (!draft) return null;
    const to = draft.mode === 'reply' ? draft.source.senderAddress : draft.to.trim();
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) {
      return { field: 'to', message: 'Enter one email address, such as friend@example.com.' };
    }
    if (!draft.subject.trim()) return { field: 'subject', message: 'Enter a subject.' };
    if (draft.mode === 'reply' && !draft.message.trim()) {
      return { field: 'message', message: 'Write a reply before simulating send.' };
    }
    const source = draft.source;
    const original = `--- ${draft.mode === 'forward' ? 'Forwarded' : 'Original'} message ---\nFrom: ${source.sender} <${source.senderAddress}>\nDate: ${source.date}\nSubject: ${source.subject}\n\n${source.body}`;
    this.sent.push({
      mode: draft.mode, sourceId: source.id, to,
      subject: draft.subject.trim(),
      body: [draft.message.trim(), original].filter(Boolean).join('\n\n'),
    });
    this.draft = null;
    this.status = `Sample ${draft.mode === 'reply' ? 'reply' : 'forward'} saved to ${to}. No email was sent.`;
    this.changed();
    return null;
  }
}
