/** The browser owns recognition and mic permission; no app API key or audio upload. */
export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onaudioend: (() => void) | null;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type RecognitionFactory = () => Recognition;
export function browserRecognition(): RecognitionFactory | undefined {
  const browser = globalThis as typeof globalThis & {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  const Constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
  return Constructor ? () => new Constructor() : undefined;
}

/** Never auto-start/restart. A generation token rejects results from closed drafts. */
export class Dictation {
  state: 'idle' | 'starting' | 'listening' | 'stopping' | 'error' | 'unavailable';
  status: string;
  interim = '';
  private recognition?: Recognition;
  private generation = 0;
  private timeout?: ReturnType<typeof setTimeout>;
  readonly supported: boolean;
  constructor(
    private readonly insert: (text: string) => void,
    private readonly changed: () => void,
    private readonly factory = browserRecognition(),
  ) {
    this.supported = !!factory;
    this.state = factory ? 'idle' : 'unavailable';
    this.status = factory ? 'Mic off. Select Record to dictate (English).' : 'Voice unavailable in this browser. Use Keyboard.';
  }
  get active(): boolean { return ['starting', 'listening', 'stopping'].includes(this.state); }
  private clearTimer(): void { if (this.timeout) clearTimeout(this.timeout); this.timeout = undefined; }
  private fail(message: string): void {
    this.abort();
    this.state = 'error';
    this.status = message;
    this.changed();
  }
  start(): void {
    if (!this.factory || this.active) return;
    const token = ++this.generation;
    let recognition: Recognition;
    try { recognition = this.factory(); }
    catch { this.fail('Voice could not start. Use Keyboard.'); return; }
    this.recognition = recognition;
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    this.state = 'starting';
    this.status = 'Requesting microphone. Allow access if prompted; Stop cancels.';
    this.interim = '';
    const live = () => token === this.generation;
    recognition.onstart = () => {
      if (!live()) return;
      this.clearTimer();
      // Bound each deliberately started recording even if browser end events fail.
      this.timeout = setTimeout(() => this.stop(), 120_000);
    };
    recognition.onaudiostart = () => {
      if (!live() || this.state === 'stopping') return;
      this.state = 'listening';
      this.status = '● RECORDING — select Stop when finished.';
      this.changed();
    };
    recognition.onaudioend = () => {
      if (!live()) return;
      this.status = 'Microphone off. Finishing transcription…';
      this.changed();
    };
    const committed = new Set<number>();
    recognition.onresult = (event) => {
      if (!live()) return;
      const pending: string[] = [];
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal && !committed.has(i)) {
          committed.add(i);
          this.insert(result[0].transcript);
        } else if (!result.isFinal) pending.push(result[0].transcript);
      }
      this.interim = pending.join(' ');
      this.changed();
    };
    recognition.onerror = ({ error }) => {
      if (!live()) return;
      const errors: Record<string, string> = {
        'not-allowed': 'Microphone denied. Allow it in browser site settings, then Record; or use Keyboard.',
        'service-not-allowed': 'Browser speech service is unavailable or blocked. Use Keyboard.',
        'audio-capture': 'No usable microphone. Check headset permissions or use Keyboard.',
        'network': 'Speech service cannot connect. Use Keyboard; no transcription service is configured by this app.',
        'no-speech': 'No speech detected. Record to retry, or use Keyboard.',
        'language-not-supported': 'English dictation is unavailable. Use Keyboard.',
        'aborted': 'Recording stopped. Record to retry, or use Keyboard.',
      };
      this.fail(errors[error] ?? 'Voice failed. Record to retry, or use Keyboard.');
    };
    recognition.onend = () => {
      if (!live()) return;
      ++this.generation;
      this.clearTimer();
      this.recognition = undefined;
      this.state = 'idle';
      this.interim = '';
      this.status = 'Mic off. Review your text before Simulate send.';
      this.changed();
    };
    this.timeout = setTimeout(() => this.fail('Microphone did not start. Check browser permission or use Keyboard.'), 15_000);
    this.changed();
    try { recognition.start(); }
    catch { this.fail('Voice start was rejected. Use Keyboard or grant microphone access in browser settings.'); }
  }
  stop(): void {
    if (!this.active) return;
    if (this.state === 'starting') { this.abort(); return; }
    if (this.state === 'stopping') return;
    this.clearTimer();
    this.state = 'stopping';
    this.status = 'Stopping microphone; finishing transcript…';
    this.changed();
    this.timeout = setTimeout(() => this.fail('Voice stopped without a final result. Review the text or use Keyboard.'), 5_000);
    try { this.recognition?.stop(); }
    catch { this.fail('Voice stopped. Review your text or use Keyboard.'); }
  }
  abort(): void {
    ++this.generation;
    this.clearTimer();
    const recognition = this.recognition;
    this.recognition = undefined;
    // Invalidate callbacks before abort, including synchronous browser callbacks.
    if (recognition) {
      recognition.onstart = recognition.onaudiostart = recognition.onaudioend = recognition.onend = null;
      recognition.onresult = recognition.onerror = null;
      try { recognition.abort(); } catch { /* Already ended. */ }
    }
    this.interim = '';
    this.state = this.supported ? 'idle' : 'unavailable';
    this.status = this.supported ? 'Mic off. Select Record to dictate (English).' : 'Voice unavailable in this browser. Use Keyboard.';
    this.changed();
  }
}
