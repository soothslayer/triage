/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createComponent, Types } from '@iwsdk/core';

/** Lifecycle states for an email card. Kept as Int32 (not Enum) to dodge
 *  elics vector/enum editor quirks — the constants below are the contract. */
export const CardState = {
  /** Resting in the arc, waiting to be triaged. */
  Queued: 0,
  /** Currently pinched/held by a hand. */
  Held: 1,
  /** Released with no flick — flying back to its arc slot. */
  Returning: 2,
  /** Triaged (archived/deleted/kept) — playing its exit animation. */
  Dismissed: 3,
} as const;

export const EmailCard = createComponent('EmailCard', {
  /** Index into MOCK_INBOX. */
  emailIndex: { type: Types.Int32, default: -1 },
  /** One of CardState. */
  state: { type: Types.Int32, default: CardState.Queued },
  /** Arc slot this card belongs to (-1 = none / dismissed). */
  slotIndex: { type: Types.Int32, default: -1 },
  /**
   * Rest position in world space. NOTE: never use setValue on this field —
   * elics throws on Vec writes. Write through the Float32Array returned by
   * entity.getVectorView(EmailCard, 'homePosition') instead.
   */
  homePosition: { type: Types.Vec3, default: [0, 0, 0] },
});
