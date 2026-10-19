/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { launchXR, SessionMode, World } from '@iwsdk/core';
import type { World as WorldType } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { HandPinchSystem } from './hand-pinch.js';
import { TriageSystem } from './triage.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(HandPinchSystem, { priority: -3.5 });
  world.registerSystem(TriageSystem);
  addVrFallbackButton(world);
});

/**
 * The browser's native XR offer now targets immersive-ar (see
 * iwsdk.config.json). Keep a small on-page "Enter VR" fallback that
 * requests a plain VR session through IWSDK's explicit launch path.
 */
function addVrFallbackButton(world: WorldType): void {
  const xr = navigator.xr as unknown as
    | { isSessionSupported?: (mode: string) => Promise<boolean> }
    | undefined;
  if (!xr?.isSessionSupported) return;
  xr.isSessionSupported('immersive-vr').then((ok) => {
    if (!ok) return;
    const btn = document.createElement('button');
    btn.textContent = 'Enter VR';
    btn.style.cssText =
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
      'z-index:10;padding:12px 20px;font-size:16px;border-radius:12px;' +
      'border:1px solid rgba(255,255,255,.25);background:rgba(10,20,40,.72);' +
      'color:#fff;cursor:pointer;';
    btn.addEventListener('click', () => {
      try {
        launchXR(world, { sessionMode: SessionMode.ImmersiveVR });
      } catch (e) {
        console.error('[triage] Enter VR failed', e);
      }
    });
    document.body.appendChild(btn);
  }).catch(() => {
    /* no VR support — nothing to offer */
  });
}
