import { Quaternion, Vector3 } from '@iwsdk/core';

// A 3 cm axis-dominant movement in roughly 100 ms is enough. Keep the decision
// briefly after the hand stops so releasing the pinch needn't be simultaneous.
const WINDOW_S = 0.12;
const MIN_DISTANCE_M = 0.03;
const MIN_SPEED_MPS = 0.3;
const AXIS_DOMINANCE = 1.3;
const RELEASE_GRACE_S = 0.16;

export type Flick = 'left' | 'right' | 'up' | 'down';

export class SwipeTracker {
  readonly yaw = new Quaternion();
  private inverseYaw = new Quaternion();
  private samples = Array.from({ length: 32 }, () => ({ time: -Infinity, pos: new Vector3() }));
  private next = 0;
  private offset = new Vector3();
  private armedAt = new Vector3();
  private direction: Flick | null = null;
  private expires = -Infinity;

  reset(position: Vector3, yaw: Quaternion, time: number): void {
    this.yaw.copy(yaw);
    this.inverseYaw.copy(yaw).invert();
    for (const sample of this.samples) sample.time = -Infinity;
    this.next = 0;
    this.direction = null;
    this.expires = -Infinity;
    this.add(position, time);
  }

  add(position: Vector3, time: number): void {
    if (time > this.expires) this.direction = null;
    this.offset.copy(position).sub(this.armedAt).applyQuaternion(this.inverseYaw);
    const vertical = this.direction === 'up' || this.direction === 'down';
    const sign = this.direction === 'right' || this.direction === 'up' ? 1 : -1;
    const along = vertical ? this.offset.y : this.offset.x;
    const across = vertical ? this.offset.x : this.offset.y;
    if (this.direction && (along * sign < -0.012 ||
      Math.abs(across) > 0.03 || Math.abs(this.offset.z) > 0.03)) {
      this.direction = null;
      this.expires = -Infinity;
      // A change of intention starts a fresh gesture, without old momentum.
      for (const sample of this.samples) sample.time = -Infinity;
    }
    // Use the oldest sample still inside the window; a short spike alone
    // cannot trigger an action without also covering the minimum distance.
    let oldest: (typeof this.samples)[number] | undefined;
    for (const sample of this.samples) {
      if (time - sample.time <= WINDOW_S && sample.time < time &&
        (!oldest || sample.time < oldest.time)) oldest = sample;
    }
    if (oldest) {
      this.offset.copy(position).sub(oldest.pos).applyQuaternion(this.inverseYaw);
      const x = Math.abs(this.offset.x);
      const y = Math.abs(this.offset.y);
      const vertical = y > x;
      const distance = Math.max(x, y);
      if (distance >= MIN_DISTANCE_M && distance / (time - oldest.time) >= MIN_SPEED_MPS &&
        distance > AXIS_DOMINANCE * Math.min(x, y) &&
        distance > AXIS_DOMINANCE * Math.abs(this.offset.z)) {
        this.direction = vertical ? (this.offset.y > 0 ? 'up' : 'down') : (this.offset.x > 0 ? 'right' : 'left');
        this.expires = time + RELEASE_GRACE_S;
        this.armedAt.copy(position);
      }
    }
    const sample = this.samples[this.next];
    sample.time = time;
    sample.pos.copy(position);
    this.next = (this.next + 1) % this.samples.length;
  }

  getFlick(time: number): Flick | null {
    return time <= this.expires ? this.direction : null;
  }

  /** Horizontal compatibility for callers interested only in archive/delete. */
  getDirection(time: number): number {
    const flick = this.getFlick(time);
    return flick === 'right' ? 1 : flick === 'left' ? -1 : 0;
  }
}
