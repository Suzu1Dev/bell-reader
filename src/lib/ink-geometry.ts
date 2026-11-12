import rough from "roughjs";
import { getStroke } from "perfect-freehand";
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

function strokePointsToSvgPath(points: number[][]): string {
  if (!points.length) return "";
  const d: string[] = [
    `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`,
    `Q ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)} ${((points[0][0] + points[1][0]) / 2).toFixed(1)} ${((points[0][1] + points[1][1]) / 2).toFixed(1)}`,
  ];
  for (let i = 1; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    d.push(`Q ${x0.toFixed(1)} ${y0.toFixed(1)} ${((x0 + x1) / 2).toFixed(1)} ${((y0 + y1) / 2).toFixed(1)}`);
  }
  d.push("Z");
  return d.join(" ");
}

/** Authentic variable-pressure chisel highlighter stroke powered by `perfect-freehand`. */
export function highlighterPath(rect: BoxRect, seed: string): string {
  const rand = seededJitter(`hl:${seed}`);
  const padX = 3.5;
  const x0 = rect.left - padX;
  const x1 = rect.left + rect.width + padX;
  const midY = rect.top + rect.height * 0.54;
  const w = Math.max(8, x1 - x0);

  const inputPoints: Array<[number, number, number]> = [
    [x0, midY + rand() * 0.9, 0.68],
    [x0 + w * 0.25, midY - 0.6 + rand() * 1.1, 0.86],
    [x0 + w * 0.55, midY + 0.5 + rand() * 1.1, 0.88],
    [x0 + w * 0.82, midY - 0.4 + rand() * 1.0, 0.84],
    [x1, midY + rand() * 0.9, 0.64],
  ];

  const outline = getStroke(inputPoints, {
    size: Math.max(16, rect.height * 0.94),
    thinning: 0.14,
    smoothing: 0.58,
    streamline: 0.44,
    simulatePressure: false,
    start: { cap: true, taper: 3 },
    end: { cap: true, taper: 4 },
  });

  return strokePointsToSvgPath(outline);
}

/** Authentic multi-stroke hand-drawn gel-pen underline powered by `roughjs`. */
export function wavyUnderlinePath(rect: BoxRect, seed: string): string {
  const s = seedInt(`ul:${seed}`);
  const rand = seededJitter(`ulw:${seed}`);
  const x0 = rect.left - 1;
  const x1 = rect.left + rect.width + 2;
  const y = rect.top + rect.height + 2.2;
  const midX = (x0 + x1) / 2;
  const drawable = generator.curve(
    [
      [x0, y + rand() * 0.8],
      [x0 + (x1 - x0) * 0.3, y - 1.4 + rand() * 0.9],
      [midX, y + 1.1 + rand() * 0.9],
      [x0 + (x1 - x0) * 0.75, y - 1.1 + rand() * 0.9],
      [x1, y + rand() * 0.8],
    ],
    {
      seed: s,
      roughness: 1.45,
      bowing: 1.3,
      strokeWidth: 1.8,
    },
  );
  return drawableToSvgPath(drawable);
}

/** Sketchy hand-circled keyword (short span) or double-stroke sketchy box (phrase) via `roughjs`. */
export function handBoxPath(rect: BoxRect, seed: string): string {
  const s = seedInt(`bx:${seed}`);
  if (rect.width <= 132) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const drawable = generator.ellipse(cx, cy, rect.width + 16, rect.height + 11, {
      seed: s,
      roughness: 1.4,
      bowing: 1.3,
      curveFitting: 0.94,
    });
    return drawableToSvgPath(drawable);
  }
  const drawable = generator.rectangle(rect.left - 4, rect.top - 3, rect.width + 8, rect.height + 6, {
    seed: s,
    roughness: 1.45,
    bowing: 1.25,
  });
  return drawableToSvgPath(drawable);
}

/** Sketchy hand-drawn margin curly bracket along the right edge of a block via `roughjs`. */
export function bracketPath(bounds: BoxRect, seed: string): string {
  const s = seedInt(`br:${seed}`);
  const x = bounds.left + bounds.width + 8;
  const y0 = bounds.top - 2;
  const y1 = bounds.top + bounds.height + 2;
  const ym = (y0 + y1) / 2;
  const drawable = generator.curve(
    [
      [x - 5, y0],
      [x + 2, y0 + 4],
      [x + 1.5, (y0 + ym) / 2],
      [x + 7, ym],
      [x + 1.5, (ym + y1) / 2],
      [x + 2, y1 - 4],
      [x - 5, y1],
    ],
    {
      seed: s,
      roughness: 1.25,
      bowing: 1.15,
    },
  );
  return drawableToSvgPath(drawable);
}

/** Sketchy curved leader line + hand-sketched arrowhead connecting text anchor to margin note via `roughjs`. */
export function leaderArrowPath(ax: number, ay: number, nx: number, ny: number, seed: string): string {
  const s = seedInt(`ld:${seed}`);
  const rand = seededJitter(`ldj:${seed}`);
  const spanX = Math.max(24, nx - ax);
  const curve = generator.curve(
    [
      [ax, ay],
      [ax + spanX * 0.38, ay + (ny - ay) * 0.16 + rand() * 5],
      [nx - spanX * 0.3, ny - (ny - ay) * 0.1 + rand() * 4],
      [nx, ny],
    ],
    {
      seed: s,
      roughness: 1.15,
      bowing: 1.1,
    },
  );
  const head = generator.linearPath(
    [
      [nx - 7.5, ny - 4.2],
      [nx, ny],
      [nx - 7.2, ny + 4.4],
    ],
    {
      seed: s + 13,
      roughness: 1.1,
    },
  );
  return `${drawableToSvgPath(curve)} ${drawableToSvgPath(head)}`;
}

/** Stacks margin notes vertically without overlap while staying as close as possible to desiredTop. */
export function layoutMarginNotes(slots: readonly MarginNoteSlot[], gap = 14): PositionedMarginNote[] {
  const ordered = [...slots].sort((a, b) => a.desiredTop - b.desiredTop);
  let cursor = 0;
  return ordered.map((slot) => {
    const top = Math.max(cursor, Math.max(0, Math.round(slot.desiredTop)));
    cursor = top + Math.max(44, Math.round(slot.height)) + gap;
    return { id: slot.id, top };
  });
}
