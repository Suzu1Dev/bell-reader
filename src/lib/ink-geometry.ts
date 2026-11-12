import rough from "roughjs";
import type { Drawable, OpSet } from "roughjs/bin/core";

export interface BoxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MarginNoteSlot {
  id: string;
  desiredTop: number;
  height: number;
}

export interface PositionedMarginNote {
  id: string;
  top: number;
}

const generator = rough.generator();

/** Deterministic integer seed >= 1 for Rough.js so sketchy strokes never flicker on re-render. */
export function seedInt(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 2147483646) + 1;
}

/** Deterministic PRNG in [-1, 1] from string seed. */
export function seededJitter(seed: string): () => number {
  let h = seedInt(seed);
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) / 2147483647.5) - 1;
  };
}

function drawableToSvgPath(drawable: Drawable): string {
  return drawable.sets
    .map((set: OpSet) => generator.opsToPath(set, 1))
    .filter(Boolean)
    .join(" ");
}

/**
 * Uniform-thickness highlighter stroke placed strictly on the lower half of the text line.
 * Never obscures upper glyph strokes, preserving crisp legibility from start to end.
 */
export function highlighterPath(rect: BoxRect, _seed: string): string {
  const strokeH = Math.max(5.5, Math.min(9.5, Number((rect.height * 0.36).toFixed(1))));
  const y0 = Number((rect.top + rect.height - strokeH + 1).toFixed(1));
  const y1 = Number((y0 + strokeH).toFixed(1));
  const x0 = Number((rect.left - 1.5).toFixed(1));
  const x1 = Number((rect.left + rect.width + 1.5).toFixed(1));
  // Uniform height from left to right with a subtle 1.5px chisel slant at nib start/end
  return `M ${x0} ${y0} L ${(x1 + 1.4).toFixed(1)} ${y0} L ${x1} ${y1} L ${(x0 - 1.4).toFixed(1)} ${y1} Z`;
}

/** Delicate single-pass ballpoint pen underline along the baseline via `roughjs`. */
export function wavyUnderlinePath(rect: BoxRect, seed: string): string {
  const s = seedInt(`ul:${seed}`);
  const rand = seededJitter(`ulw:${seed}`);
  const x0 = rect.left;
  const x1 = rect.left + rect.width;
  const y = rect.top + rect.height + 1.5;
  const span = Math.max(8, x1 - x0);
  const drawable = generator.curve(
    [
      [x0, y + rand() * 0.6],
      [x0 + span * 0.34, y - 0.9 + rand() * 0.7],
      [x0 + span * 0.68, y + 0.8 + rand() * 0.7],
      [x1, y + rand() * 0.6],
    ],
    {
      seed: s,
      roughness: 0.75,
      bowing: 0.9,
      disableMultiStroke: true,
    },
  );
  return drawableToSvgPath(drawable);
}

/** Fine ballpoint pen ellipse around a short keyword or tight rectangle around a phrase via `roughjs`. */
export function handBoxPath(rect: BoxRect, seed: string): string {
  const s = seedInt(`bx:${seed}`);
  if (rect.width <= 136) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const drawable = generator.ellipse(cx, cy, rect.width + 12, rect.height + 8, {
      seed: s,
      roughness: 0.9,
      bowing: 1.0,
      curveFitting: 0.95,
      disableMultiStroke: true,
    });
    return drawableToSvgPath(drawable);
  }
  const drawable = generator.rectangle(rect.left - 3, rect.top - 2, rect.width + 6, rect.height + 4, {
    seed: s,
    roughness: 0.95,
    bowing: 0.9,
    disableMultiStroke: true,
  });
  return drawableToSvgPath(drawable);
}

/** Slim ballpoint margin curly bracket via `roughjs`. */
export function bracketPath(bounds: BoxRect, seed: string): string {
  const s = seedInt(`br:${seed}`);
  const x = bounds.left + bounds.width + 7;
  const y0 = bounds.top - 1;
  const y1 = bounds.top + bounds.height + 1;
  const ym = (y0 + y1) / 2;
  const drawable = generator.curve(
    [
      [x - 4, y0],
      [x + 1.5, y0 + 3.5],
      [x + 1, (y0 + ym) / 2],
      [x + 5.5, ym],
      [x + 1, (ym + y1) / 2],
      [x + 1.5, y1 - 3.5],
      [x - 4, y1],
    ],
    {
      seed: s,
      roughness: 0.85,
      bowing: 0.9,
      disableMultiStroke: true,
    },
  );
  return drawableToSvgPath(drawable);
}

/**
 * 360-degree directional ballpoint pen arrow from text anchor (ax, ay) to note edge (nx, ny).
 * Works cleanly for inline-right, under-block downward, close left margin, and close right margin.
 */
export function leaderArrowPath(ax: number, ay: number, nx: number, ny: number, seed: string): string {
  const s = seedInt(`ld:${seed}`);
  const rand = seededJitter(`ldj:${seed}`);
  const dx = nx - ax;
  const dy = ny - ay;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  // Perpendicular normal
  const px = -uy;
  const py = ux;

  const arcMag = Math.min(16, Math.max(4, dist * 0.16)) * (dy >= 0 ? 1 : -1);
  const jitter1 = rand() * 3;
  const jitter2 = rand() * 3;

  const c1x = ax + dx * 0.35 + px * (arcMag + jitter1);
  const c1y = ay + dy * 0.35 + py * (arcMag + jitter1);
  const c2x = ax + dx * 0.72 + px * (arcMag * 0.65 + jitter2);
  const c2y = ay + dy * 0.72 + py * (arcMag * 0.65 + jitter2);

  const curve = generator.curve(
    [
      [ax, ay],
      [c1x, c1y],
      [c2x, c2y],
      [nx, ny],
    ],
    {
      seed: s,
      roughness: 0.7,
      bowing: 0.75,
      disableMultiStroke: true,
    },
  );

  // Tangent near tip (c2 -> n) so arrowhead always aligns smoothly with arrow angle
  const tx = nx - c2x;
  const ty = ny - c2y;
  const tLen = Math.hypot(tx, ty) || 1;
  const tux = tx / tLen;
  const tuy = ty / tLen;
  const tipLen = 6.2;
  const tipSpread = 3.2;

  const leftWing: [number, number] = [
    nx - tux * tipLen - tuy * tipSpread,
    ny - tuy * tipLen + tux * tipSpread,
  ];
  const rightWing: [number, number] = [
    nx - tux * tipLen + tuy * tipSpread,
    ny - tuy * tipLen - tux * tipSpread,
  ];

  const head = generator.linearPath(
    [leftWing, [nx, ny], rightWing],
    {
      seed: s + 13,
      roughness: 0.65,
      disableMultiStroke: true,
    },
  );
  return `${drawableToSvgPath(curve)} ${drawableToSvgPath(head)}`;
}

/** Stacks margin notes vertically without overlap while staying as close as possible to desiredTop. */
export function layoutMarginNotes(slots: readonly MarginNoteSlot[], gap = 12): PositionedMarginNote[] {
  const ordered = [...slots].sort((a, b) => a.desiredTop - b.desiredTop);
  let cursor = 0;
  return ordered.map((slot) => {
    const top = Math.max(cursor, Math.max(0, Math.round(slot.desiredTop)));
    cursor = top + Math.max(36, Math.round(slot.height)) + gap;
    return { id: slot.id, top };
  });
}
