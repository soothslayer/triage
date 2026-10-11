/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Canvas-texture helpers. Triage renders all of its UI (email cards, HUD,
 * bin label, hints) as canvas textures on planes — no UIKit dependency for
 * the scaffold, and everything stays readable under any lighting because
 * the materials are unlit (MeshBasicMaterial).
 */

import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry } from '@iwsdk/core';
import type { Email } from './mockInbox.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Greedy word wrap; returns lines that fit maxWidth. */
function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function cardBase(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  roundRect(ctx, 4, 4, w - 8, h - 8, 36);
  ctx.fillStyle = 'rgba(16, 22, 40, 0.94)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(120, 160, 255, 0.55)';
  ctx.lineWidth = 3;
  ctx.stroke();
  // Accent bar on the left edge.
  ctx.fillStyle = '#7aa2ff';
  roundRect(ctx, 4, 4, 18, h - 8, 9);
  ctx.fill();
}

export interface CardTextures {
  face: CanvasTexture;
  expanded: CanvasTexture;
}

/** Renders the compact card face and the expanded (grabbed) view. */
export function makeCardTextures(email: Email): CardTextures {
  // --- Face: 720x480 ---
  const faceCanvas = document.createElement('canvas');
  faceCanvas.width = 720;
  faceCanvas.height = 480;
  const f = faceCanvas.getContext('2d')!;
  cardBase(f, 720, 480);
  const pad = 64;
  const textW = 720 - pad * 2 - 24;

  f.fillStyle = '#9db4ff';
  f.font = `600 30px ${FONT}`;
  f.fillText(email.sender.toUpperCase(), pad + 24, 92);

  f.fillStyle = '#ffffff';
  f.font = `700 40px ${FONT}`;
  const subjectLines = wrap(f, email.subject, textW).slice(0, 2);
  subjectLines.forEach((ln, i) => f.fillText(ln, pad + 24, 152 + i * 52));

  f.fillStyle = 'rgba(220, 230, 255, 0.75)';
  f.font = `400 32px ${FONT}`;
  const previewLines = wrap(f, email.preview.replace(/\n/g, ' '), textW).slice(
    0,
    3,
  );
  previewLines.forEach((ln, i) => f.fillText(ln, pad + 24, 250 + i * 46));

  f.fillStyle = 'rgba(160, 175, 210, 0.8)';
  f.font = `400 28px ${FONT}`;
  f.fillText(email.date, pad + 24, 480 - 48);

  // --- Expanded: 720x1000, full body ---
  const expCanvas = document.createElement('canvas');
  expCanvas.width = 720;
  expCanvas.height = 1000;
  const e = expCanvas.getContext('2d')!;
  cardBase(e, 720, 1000);

  e.fillStyle = '#9db4ff';
  e.font = `600 30px ${FONT}`;
  e.fillText(email.sender.toUpperCase(), pad + 24, 92);

  e.fillStyle = '#ffffff';
  e.font = `700 42px ${FONT}`;
  wrap(e, email.subject, textW)
    .slice(0, 3)
    .forEach((ln, i) => e.fillText(ln, pad + 24, 152 + i * 54));

  e.fillStyle = 'rgba(230, 238, 255, 0.92)';
  e.font = `400 34px ${FONT}`;
  wrap(e, email.body, textW)
    .slice(0, 14)
    .forEach((ln, i) => e.fillText(ln, pad + 24, 300 + i * 50));

  e.fillStyle = 'rgba(160, 175, 210, 0.8)';
  e.font = `400 28px ${FONT}`;
  e.fillText(email.date, pad + 24, 1000 - 48);

  const face = new CanvasTexture(faceCanvas);
  const expanded = new CanvasTexture(expCanvas);
  // Keep text crisp at glancing angles.
  face.anisotropy = 4;
  expanded.anisotropy = 4;
  return { face, expanded };
}

/** A plane mesh showing a texture, unlit so it reads in any environment. */
export function makeTexturedPlane(
  widthM: number,
  heightM: number,
  texture: CanvasTexture,
  opacity = 1,
): Mesh {
  const mat = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity,
  });
  const mesh = new Mesh(new PlaneGeometry(widthM, heightM), mat);
  return mesh;
}

/** Small helper for one-off labels (bin, hints, overlays). */
export function makeLabelPlane(
  text: string,
  widthM: number,
  opts: {
    fontPx?: number;
    color?: string;
    sub?: string;
  } = {},
): Mesh {
  const { fontPx = 64, color = '#ffffff', sub } = opts;
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = sub ? 320 : 192;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;
  ctx.font = `700 ${fontPx}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(text, 512, sub ? 130 : 120);
  if (sub) {
    ctx.fillStyle = 'rgba(220, 230, 255, 0.75)';
    ctx.font = `400 44px ${FONT}`;
    ctx.fillText(sub, 512, 230);
  }
  const tex = new CanvasTexture(canvas);
  tex.anisotropy = 4;
  const h = (widthM * canvas.height) / canvas.width;
  return makeTexturedPlane(widthM, h, tex);
}
