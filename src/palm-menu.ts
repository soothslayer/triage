import { Vector3 } from '@iwsdk/core';

/**
 * Reports how directly the palm faces the player's head: +1 = palm dead-on
 * toward the face, -1 = back of the hand. Exposes `facing` (-1..1) and
 * `dist` (meters, palm to head). Call `read()` per frame; it returns false
 * when joints aren't tracked.
 *
 * Palm normal from joints (handedness-correct):
 *   fingerDir = middle_tip - middle_metacarpal   (along the fingers)
 *   acrossDir = pinky_mcp - index_mcp            (across the palm)
 *   right hand: normal = fingerDir x acrossDir
 *   left hand:  normal = acrossDir x fingerDir
 *
 * Joint positions arrive in XR reference space. toWorld maps reference
 * space into the scene's world space (the same conversion the swipe tracker
 * relies on); the normal is transformed by mapping two points and taking
 * their difference, so no quaternion convention is assumed.
 */
export class PalmFacingReader {
  readonly facing = { value: 0 };
  readonly dist = { value: Infinity };
  private wrist = new Vector3();
  private mcpMid = new Vector3();
  private tipMid = new Vector3();
  private mcpIndex = new Vector3();
  private mcpPinky = new Vector3();
  private fingerDir = new Vector3();
  private acrossDir = new Vector3();
  private normal = new Vector3();
  private palmPos = new Vector3();
  private tip = new Vector3();
  private toHead = new Vector3();

  read(
    frame: XRFrame,
    space: XRReferenceSpace,
    hand: XRHand,
    handedness: 'left' | 'right',
    toWorld: (v: Vector3) => void,
    headWorld: Vector3,
  ): boolean {
    const joint = (name: XRHandJoint, out: Vector3): boolean => {
      const source = hand.get(name);
      const pose = source && frame.getJointPose?.(source, space);
      if (!pose || pose.emulatedPosition) return false;
      const p = pose.transform.position;
      out.set(p.x, p.y, p.z);
      return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
    };
    if (!joint('wrist', this.wrist)) return false;
    if (!joint('middle-finger-metacarpal', this.mcpMid)) return false;
    if (!joint('middle-finger-tip', this.tipMid)) return false;
    if (!joint('index-finger-metacarpal', this.mcpIndex)) return false;
    if (!joint('pinky-finger-metacarpal', this.mcpPinky)) return false;
    this.palmPos.copy(this.wrist).lerp(this.mcpMid, 0.5);
    this.fingerDir.copy(this.tipMid).sub(this.mcpMid);
    this.acrossDir.copy(this.mcpPinky).sub(this.mcpIndex);
    if (
      this.fingerDir.lengthSq() < 1e-8 ||
      this.acrossDir.lengthSq() < 1e-8
    )
      return false;
    this.fingerDir.normalize();
    this.acrossDir.normalize();
    if (handedness === 'right') this.normal.copy(this.fingerDir).cross(this.acrossDir);
    else this.normal.copy(this.acrossDir).cross(this.fingerDir);
    // Transform two reference-space points to world; their difference is the
    // world-space normal. (Adding the ref-space normal to the ref-space palm
    // point first — do NOT mix spaces.)
    this.tip.copy(this.palmPos).add(this.normal);
    toWorld(this.palmPos);
    toWorld(this.tip);
    this.normal.copy(this.tip).sub(this.palmPos).normalize();
    this.toHead.copy(headWorld).sub(this.palmPos);
    const d = this.toHead.length();
    if (!(d > 1e-6)) return false;
    this.toHead.divideScalar(d);
    this.facing.value = this.normal.dot(this.toHead);
    this.dist.value = d;
    return true;
  }
}
