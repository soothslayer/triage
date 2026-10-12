import { createSystem } from '@iwsdk/core';

type Hand = 'left' | 'right';
const HANDS: Hand[] = ['left', 'right'];

/**
 * IWSDK 1.0.1 forwards gamepad pinches to near grabs, but native WebXR hands
 * may have no gamepad. Forward their session select edges after InputSystem
 * has hit-tested the hands and before GrabSystem updates its handles.
 */
export class HandPinchSystem extends createSystem({}) {
  private session: XRSession | undefined;
  private pending: Record<Hand, XRInputSourceEvent[]> = { left: [], right: [] };
  private held: Partial<Record<Hand, XRInputSource>> = {};

  private onSelect = (event: XRInputSourceEvent): void => {
    const source = event.inputSource;
    const hand = source.handedness;
    if (!source.hand || (hand !== 'left' && hand !== 'right')) return;
    // The normal SDK path already handles gamepad-backed sources.
    if (source.gamepad) return;
    const queue = this.pending[hand];
    // Bound queued events across a suspended renderer, preserving edge pairs.
    if (queue.length >= 32) queue.splice(0, 2);
    queue.push(event);
  };

  init(): void {
    const sync = () => this.syncSession();
    this.xrManager.addEventListener('sessionstart', sync);
    this.xrManager.addEventListener('sessionend', sync);
    this.syncSession();
    this.cleanupFuncs.push(() => {
      this.xrManager.removeEventListener('sessionstart', sync);
      this.xrManager.removeEventListener('sessionend', sync);
      this.detachSession();
    });
  }

  private release(hand: Hand): void {
    if (!this.held[hand]) return;
    this.input.xr.multiPointers[hand].routeUp('squeeze', 'grab', {
      timeStamp: performance.now(),
    });
    delete this.held[hand];
  }

  private detachSession(): void {
    this.session?.removeEventListener('selectstart', this.onSelect);
    this.session?.removeEventListener('selectend', this.onSelect);
    for (const hand of HANDS) {
      this.release(hand);
      this.pending[hand].length = 0;
    }
    this.session = undefined;
  }

  private syncSession(): void {
    const session = this.world.xrSession;
    if (session === this.session) return;
    this.detachSession();
    this.session = session;
    session?.addEventListener('selectstart', this.onSelect);
    session?.addEventListener('selectend', this.onSelect);
  }

  update(): void {
    this.syncSession();
    for (const hand of HANDS) {
      const source = this.input.xr.getPrimaryInputSource(hand);
      if (this.held[hand] && this.held[hand] !== source) this.release(hand);
      // One edge per frame preserves a short pinch that begins and ends
      // between frames: GrabSystem must observe both held and released states.
      const event = this.pending[hand].shift();
      if (!event || event.inputSource !== source || this.input.xr.gamepads[hand]) continue;
      const pointer = this.input.xr.multiPointers[hand];
      if (event.type === 'selectstart') {
        // Native ray selection is handled by the SDK; only bridge near grabs.
        if (pointer.getActivePointer() !== pointer.getPointer('grab')) continue;
        pointer.routeDown('squeeze', 'grab', { timeStamp: event.timeStamp });
        this.held[hand] = source;
      } else {
        this.release(hand);
      }
    }
  }
}
