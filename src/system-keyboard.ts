/** Meta Quest Browser's WebXR keyboard bridge, not an app-rendered keyboard.
 * https://developers.meta.com/vr/documentation/web/webxr-keyboard/
 */
export type KeyboardSession = XRSession & { readonly isSystemKeyboardSupported?: boolean };
export class SystemKeyboard {
  private session?: KeyboardSession;
  private element?: HTMLInputElement | HTMLTextAreaElement;
  private generation = 0;
  status = '';
  get supported(): boolean { return this.session?.isSystemKeyboardSupported === true; }
  get active(): boolean { return !!this.element; }
  constructor(private changed: () => void) {}

  setSession(session?: XRSession): void {
    if (session === this.session) return;
    this.close();
    this.session?.removeEventListener('end', this.end);
    this.session?.removeEventListener('visibilitychange', this.visibility);
    this.session = session;
    session?.addEventListener('end', this.end);
    session?.addEventListener('visibilitychange', this.visibility);
    this.status = this.supported ? 'Horizon keyboard ready.' : 'Horizon keyboard unavailable in this XR session. Use a supported Quest Browser.';
    this.changed();
  }
  private end = (): void => { this.setSession(undefined); };
  private visibility = (): void => {
    // visible-blurred is normal while the OS keyboard owns focus. Do not close it.
    if (this.session?.visibilityState === 'hidden') this.close();
  };
  open(field: 'to' | 'subject' | 'message', apply: (text: string) => void): boolean {
    this.close();
    if (!this.supported) {
      this.status = 'Horizon keyboard unavailable in this XR session. No custom keyboard or browser form is substituted.';
      this.changed();
      return false;
    }
    const token = ++this.generation;
    // Keep the bridge in the viewport so focusing cannot scroll the underlying page.
    // It is invisible, not display:none/offscreen: the browser must be able to focus it.
    const element = field === 'message' ? document.createElement('textarea') : document.createElement('input');
    if (field !== 'message') (element as HTMLInputElement).type = 'text';
    element.setAttribute('data-triage-system-keyboard', field);
    element.setAttribute('aria-label', `Horizon keyboard: ${field}`);
    element.tabIndex = -1;
    element.autocomplete = 'off';
    element.spellcheck = field !== 'to';
    element.inputMode = field === 'to' ? 'email' : 'text';
    element.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;margin:0;padding:0;border:0;opacity:0;pointer-events:none;';
    // Meta documents first-keystroke replacement on every keyboard presentation.
    // Use a fresh edit buffer; the editor preserves/merges the original separately.
    element.value = '';
    this.element = element;
    let lastRead = '';
    const read = () => {
      if (token !== this.generation) return;
      lastRead = element.value;
      apply(lastRead);
    };
    element.oninput = read;
    element.onblur = () => {
      if (token !== this.generation) return;
      if (element.value !== lastRead) read();
      this.close();
      this.status = 'Keyboard closed. Review the spatial panel before Simulate send.';
      this.changed();
    };
    document.body.appendChild(element);
    this.status = 'Horizon keyboard requested. Type, then dismiss it to review the panel.';
    try {
      element.focus({ preventScroll: true });
      if (document.activeElement !== element) throw new Error('Focus rejected');
    } catch {
      this.close();
      this.status = 'System keyboard focus was rejected. Retry in Quest Browser; your draft is preserved.';
      this.changed();
      return false;
    }
    this.changed();
    return true;
  }
  close(): void {
    ++this.generation;
    const element = this.element;
    this.element = undefined;
    if (element) {
      element.oninput = element.onblur = null;
      element.blur();
      element.remove();
      this.status = 'Keyboard closed. Draft kept in the spatial panel.';
      this.changed();
    }
  }
  dispose(): void { this.setSession(undefined); }
}
