import { Quaternion, Vector3 } from '@iwsdk/core';

const FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'] as const;

/** Read tracked joints in XR reference-space coordinates; no controller fallback. */
export class OpenPalmReader {
  readonly position = new Vector3();
  private wrist = new Vector3();
  private base = new Vector3();
  private middle = new Vector3();
  private tip = new Vector3();
  private index = new Vector3();
  private thumb = new Vector3();

  read(frame: XRFrame, space: XRReferenceSpace, hand: XRHand): boolean {
    const joint = (name: XRHandJoint, out: Vector3): boolean => {
      const source = hand.get(name);
      const pose = source && frame.getJointPose?.(source, space);
      if (!pose || pose.emulatedPosition) return false;
      const p = pose.transform.position;
      out.set(p.x, p.y, p.z);
      return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
    };
    if (!joint('wrist', this.wrist) || !joint('middle-finger-metacarpal', this.base)) return false;
    this.position.copy(this.wrist).lerp(this.base, .5);
    for (const finger of FINGERS) {
      if (!joint(`${finger}-phalanx-proximal`, this.base) ||
          !joint(`${finger}-phalanx-intermediate`, this.middle) ||
          !joint(`${finger}-tip`, this.tip)) return false;
      const length = this.base.distanceTo(this.middle) + this.middle.distanceTo(this.tip);
      // Extended fingers have a nearly straight chain and point away from the wrist.
      if (length < .025 || this.base.distanceTo(this.tip) < length * .9 ||
          this.tip.distanceTo(this.wrist) < this.base.distanceTo(this.wrist) + .025) return false;
      if (finger === 'index-finger') this.index.copy(this.tip);
    }
    return joint('thumb-tip', this.thumb) && this.thumb.distanceTo(this.index) > .04;
  }
}

/** Brief steady open palm, then a deliberate horizontal sweep. Fires once until reset. */
export class PalmSwipeTracker {
  readonly yaw = new Quaternion();
  ready = false;
  private origin = new Vector3();
  private offset = new Vector3();
  private inverse = new Quaternion();
  private started = -Infinity;
  private last = -Infinity;
  private fired = false;

  reset(): void { this.started = this.last = -Infinity; this.ready = this.fired = false; }

  add(position: Vector3, yaw: Quaternion, time: number): -1 | 0 | 1 {
    if (this.fired) return 0;
    if (time - this.last > .08 || time <= this.last) this.reset();
    this.last = time;
    if (!Number.isFinite(this.started)) {
      this.started = time; this.origin.copy(position);
      this.yaw.copy(yaw); this.inverse.copy(yaw).invert();
      return 0;
    }
    this.offset.copy(position).sub(this.origin).applyQuaternion(this.inverse);
    if (!this.ready) {
      if (this.offset.length() > .025) { this.started = time; this.origin.copy(position); }
      else if (time - this.started >= .12) {
        this.ready = true; this.started = time; this.origin.copy(position);
      }
      return 0;
    }
    const age = time - this.started;
    const x = Math.abs(this.offset.x);
    if (age > .65 || Math.abs(this.offset.y) > .07 || Math.abs(this.offset.z) > .07) {
      this.reset(); return 0;
    }
    if (x >= .12 && x / age >= .35 && x > 2 * Math.abs(this.offset.y) && x > 2 * Math.abs(this.offset.z)) {
      this.fired = true;
      return this.offset.x > 0 ? 1 : -1;
    }
    return 0;
  }
}
