import rough from "roughjs";
import type { Drawable, OpSet } from "roughjs/bin/core";
import type { AnnotationSketch } from "../../shared/types";

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

/** Hand-drawn ballpoint circle pin for circling a point on an image or diagram via `roughjs`. */
export function handPinCirclePath(cx: number, cy: number, radius: number, seed: string): string {
  const s = seedInt(`pin:${seed}`);
  const drawable = generator.ellipse(cx, cy, radius * 2, radius * 2, {
    seed: s,
    roughness: 0.95,
    bowing: 0.95,
    curveFitting: 0.95,
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

export interface SketchLabel {
  x: number;
  y: number;
  lines: string[];
  align?: "start" | "middle" | "end";
  small?: boolean;
}

export interface SketchDiagramData {
  width: number;
  height: number;
  fillPaths: string[];
  strokePaths: string[];
  accentPaths: string[];
  labels: SketchLabel[];
}

function wrapSketchText(text: string, maxUnits: number): string[] {
  const clean = text.trim();
  if (!clean) return [""];
  // Split CJK/Latin strings by approximate glyph width into max 2 lines.
  const unitOf = (ch: string) => {
    const c = ch.charCodeAt(0);
    if (c > 0x2e7f) return 1.75;
    if ("()[]{}.,:-/ ".includes(ch)) return 0.6;
    return 0.85;
  };
  let total = 0;
  for (const ch of clean) total += unitOf(ch);
  if (total <= maxUnits) return [clean];

  let acc = 0;
  let splitAt = clean.length;
  for (let i = 0; i < clean.length; i++) {
    acc += unitOf(clean[i]);
    if (acc >= maxUnits && splitAt === clean.length) {
      splitAt = i + 1;
      break;
    }
  }
  const spaceIdx = clean.lastIndexOf(" ", splitAt);
  const cut = spaceIdx > 1 ? spaceIdx : splitAt;
  const line1 = clean.slice(0, cut).trim();
  const rest = clean.slice(cut).trim();
  if (!rest) return [line1];
  let line2 = "";
  let rUnits = 0;
  for (const ch of rest) {
    const u = unitOf(ch);
    if (rUnits + u > maxUnits - 1 && rest.length > line2.length + 1) {
      line2 += "…";
      break;
    }
    line2 += ch;
    rUnits += u;
  }
  return [line1, line2];
}

function softWashQuad(x: number, y: number, w: number, h: number): string {
  return `M ${(x + 1.5).toFixed(1)} ${(y + 1).toFixed(1)} L ${(x + w - 1).toFixed(1)} ${(y + 1.5).toFixed(1)} L ${(x + w - 1.5).toFixed(1)} ${(y + h - 1).toFixed(1)} L ${(x + 1).toFixed(1)} ${(y + h - 1.5).toFixed(1)} Z`;
}

function sketchArrow(x1: number, y1: number, x2: number, y2: number, s: number): string {
  const line = generator.line(x1, y1, x2, y2, {
    seed: s,
    roughness: 0.75,
    disableMultiStroke: true,
  });
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const tip = generator.linearPath(
    [
      [x2 - ux * 5.2 - uy * 3.1, y2 - uy * 5.2 + ux * 3.1],
      [x2, y2],
      [x2 - ux * 5.2 + uy * 3.1, y2 - uy * 5.2 - ux * 3.1],
    ],
    { seed: s + 7, roughness: 0.65, disableMultiStroke: true },
  );
  return `${drawableToSvgPath(line)} ${drawableToSvgPath(tip)}`;
}

/**
 * Deterministic Rough.js explanatory diagram rendered inside margin note cards
 * for 4 structural primitives (`flow`, `compare`, `layers`, `axes`).
 */
export function buildSketchDiagram(sketch: AnnotationSketch, seed: string): SketchDiagramData {
  const s = seedInt(`sk:${seed}:${sketch.kind}`);
  const nodes = sketch.nodes.slice(0, 4);
  const width = 232;
  const fillPaths: string[] = [];
  const strokePaths: string[] = [];
  const accentPaths: string[] = [];
  const labels: SketchLabel[] = [];

  if (sketch.kind === "flow") {
    if (nodes.length <= 3) {
      const height = 66;
      const n = Math.max(2, nodes.length);
      const padX = 6;
      const arrowW = n === 2 ? 32 : 16;
      const boxW = (width - padX * 2 - arrowW * (n - 1)) / n;
      const boxH = 40;
      const boxY = 13;
      const maxUnits = n === 2 ? 12.5 : 8.5;

      nodes.forEach((node, i) => {
        const bx = padX + i * (boxW + arrowW);
        if (i === 0 || i === n - 1) fillPaths.push(softWashQuad(bx, boxY, boxW, boxH));
        strokePaths.push(
          drawableToSvgPath(
            generator.rectangle(bx, boxY, boxW, boxH, {
              seed: s + i * 17,
              roughness: 0.9,
              disableMultiStroke: true,
            }),
          ),
        );
        labels.push({
          x: bx + boxW / 2,
          y: boxY + boxH / 2,
          lines: wrapSketchText(node, maxUnits),
          align: "middle",
        });
        if (i < n - 1) {
          accentPaths.push(sketchArrow(bx + boxW + 3, boxY + boxH / 2, bx + boxW + arrowW - 3, boxY + boxH / 2, s + 100 + i));
        }
      });
      return { width, height, fillPaths, strokePaths, accentPaths, labels };
    }

    // 4-node 2x2 pipeline
    const height = 104;
    const boxW = 92;
    const boxH = 34;
    const positions: Array<[number, number]> = [
      [8, 10],
      [132, 10],
      [8, 60],
      [132, 60],
    ];
    nodes.forEach((node, i) => {
      const [bx, by] = positions[i];
      if (i === 0 || i === 3) fillPaths.push(softWashQuad(bx, by, boxW, boxH));
      strokePaths.push(
        drawableToSvgPath(
          generator.rectangle(bx, by, boxW, boxH, {
            seed: s + i * 19,
            roughness: 0.9,
            disableMultiStroke: true,
          }),
        ),
      );
      labels.push({
        x: bx + boxW / 2,
        y: by + boxH / 2,
        lines: wrapSketchText(node, 11.5),
        align: "middle",
      });
    });
    accentPaths.push(sketchArrow(103, 27, 129, 27, s + 201));
    accentPaths.push(sketchArrow(148, 45, 84, 59, s + 202));
    accentPaths.push(sketchArrow(103, 77, 129, 77, s + 203));
    return { width, height, fillPaths, strokePaths, accentPaths, labels };
  }

  if (sketch.kind === "compare") {
    const height = 74;
    const n = Math.max(2, Math.min(3, nodes.length));
    const padX = 4;
    const gap = 5;
    const colW = (width - padX * 2 - gap * (n - 1)) / n;
    const boxH = 52;
    const boxY = 11;
    const maxUnits = n === 2 ? 14.5 : 9.8;

    nodes.slice(0, n).forEach((node, i) => {
      const cx = padX + i * (colW + gap);
      if (i === n - 1) fillPaths.push(softWashQuad(cx, boxY, colW, boxH));
      strokePaths.push(
        drawableToSvgPath(
          generator.rectangle(cx, boxY, colW, boxH, {
            seed: s + i * 23,
            roughness: 0.85,
            disableMultiStroke: true,
          }),
        ),
      );
      strokePaths.push(
        drawableToSvgPath(
          generator.line(cx + 8, boxY + 14, cx + colW - 8, boxY + 14, {
            seed: s + i * 29 + 5,
            roughness: 0.7,
            disableMultiStroke: true,
          }),
        ),
      );
      labels.push({
        x: cx + colW / 2,
        y: boxY + 34,
        lines: wrapSketchText(node, maxUnits),
        align: "middle",
      });
    });
    return { width, height, fillPaths, strokePaths, accentPaths, labels };
  }

  if (sketch.kind === "layers") {
    const count = Math.max(2, nodes.length);
    const slabH = 22;
    const gap = 5;
    const topPad = 8;
    const height = topPad * 2 + count * slabH + (count - 1) * gap;
    const slabX = 12;
    const slabW = width - 24;

    nodes.forEach((node, i) => {
      const sy = topPad + i * (slabH + gap);
      if (i % 2 === 0) fillPaths.push(softWashQuad(slabX, sy, slabW, slabH));
      strokePaths.push(
        drawableToSvgPath(
          generator.rectangle(slabX, sy, slabW, slabH, {
            seed: s + i * 31,
            roughness: 0.85,
            disableMultiStroke: true,
          }),
        ),
      );
      labels.push({
        x: slabX + slabW / 2,
        y: sy + slabH / 2 + 1,
        lines: wrapSketchText(node, 22),
        align: "middle",
      });
    });
    return { width, height, fillPaths, strokePaths, accentPaths, labels };
  }

  // axes (2–3 labels + curve shape)
  const height = 90;
  strokePaths.push(sketchArrow(26, 68, 26, 12, s + 11));
  strokePaths.push(sketchArrow(26, 68, 218, 68, s + 12));

  const shape = sketch.shape ?? "rise";
  const curvePts: Array<[number, number]> =
    shape === "drop"
      ? [
          [34, 18],
          [82, 35],
          [144, 54],
          [206, 61],
        ]
      : shape === "peak"
        ? [
            [34, 59],
            [82, 42],
            [120, 16],
            [158, 42],
            [206, 59],
          ]
        : shape === "threshold"
          ? [
              [34, 57],
              [102, 55],
              [126, 33],
              [154, 19],
              [206, 18],
            ]
          : [
              [34, 62],
              [86, 56],
              [146, 37],
              [206, 16],
            ];

  accentPaths.push(
    drawableToSvgPath(
      generator.curve(curvePts, {
        seed: s + 41,
        roughness: 0.75,
        bowing: 0.7,
        disableMultiStroke: true,
      }),
    ),
  );

  if (shape === "peak" || shape === "threshold") {
    const markerX = shape === "peak" ? 120 : 116;
    strokePaths.push(
      drawableToSvgPath(
        generator.line(markerX, 18, markerX, 68, {
          seed: s + 53,
          roughness: 0.6,
          disableMultiStroke: true,
        }),
      ),
    );
  }

  if (nodes[0]) {
    labels.push({
      x: 28,
      y: 82,
      lines: wrapSketchText(nodes[0], 12),
      align: "start",
      small: true,
    });
  }
  if (nodes[1]) {
    labels.push({
      x: 218,
      y: 82,
      lines: wrapSketchText(nodes[1], 12),
      align: "end",
      small: true,
    });
  }
  if (nodes[2]) {
    labels.push({
      x: 122,
      y: 12,
      lines: wrapSketchText(nodes[2], 14),
      align: "middle",
      small: true,
    });
  }
  return { width, height, fillPaths, strokePaths, accentPaths, labels };
}
