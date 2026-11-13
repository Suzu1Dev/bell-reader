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
  size?: "sm" | "md" | "lg";
}

export interface SketchDot {
  x: number;
  y: number;
  r: number;
}

export interface SketchDiagramData {
  minX: number;
  minY: number;
  width: number;
  height: number;
  fillPaths: string[];
  strokePaths: string[];
  dashedPaths: string[];
  accentPaths: string[];
  dots: SketchDot[];
  labels: SketchLabel[];
}

function wrapSketchText(text: string, maxUnits: number): string[] {
  const clean = text.trim();
  if (!clean) return [""];
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

function ellipseWashPath(cx: number, cy: number, rx: number, ry: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const px = cx + Math.cos(a) * Math.max(4, rx - 1.5);
    const py = cy + Math.sin(a) * Math.max(4, ry - 1.5);
    pts.push(`${i === 0 ? "M" : "L"} ${px.toFixed(1)} ${py.toFixed(1)}`);
  }
  return `${pts.join(" ")} Z`;
}

function polygonPath(points: ReadonlyArray<readonly [number, number]>, close = true): string {
  if (points.length === 0) return "";
  const segs = points.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`);
  return close ? `${segs.join(" ")} Z` : segs.join(" ");
}

function pillFramePath(x: number, y: number, w: number, h: number, s: number): string {
  const r = Math.min(h * 0.42, 16);
  const pts: Array<[number, number]> = [
    [x + r, y],
    [x + w * 0.5, y],
    [x + w - r, y],
    [x + w, y + r],
    [x + w, y + h - r],
    [x + w - r, y + h],
    [x + w * 0.5, y + h],
    [x + r, y + h],
    [x, y + h - r],
    [x, y + r],
    [x + r, y],
  ];
  return drawableToSvgPath(
    generator.curve(pts, {
      seed: s,
      roughness: 0.78,
      curveFitting: 0.96,
      disableMultiStroke: true,
    }),
  );
}

function sketchArrow(x1: number, y1: number, x2: number, y2: number, s: number, bend = 0): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;

  let body: Drawable;
  let tx = dx;
  let ty = dy;
  if (Math.abs(bend) > 1.5) {
    const mx = (x1 + x2) / 2 + px * bend;
    const my = (y1 + y2) / 2 + py * bend;
    const q1x = (x1 + mx) / 2 + px * bend * 0.35;
    const q1y = (y1 + my) / 2 + py * bend * 0.35;
    const q2x = (mx + x2) / 2 + px * bend * 0.35;
    const q2y = (my + y2) / 2 + py * bend * 0.35;
    body = generator.curve(
      [
        [x1, y1],
        [q1x, q1y],
        [mx, my],
        [q2x, q2y],
        [x2, y2],
      ],
      { seed: s, roughness: 0.72, bowing: 0.75, disableMultiStroke: true },
    );
    tx = x2 - q2x;
    ty = y2 - q2y;
  } else {
    body = generator.line(x1, y1, x2, y2, {
      seed: s,
      roughness: 0.75,
      disableMultiStroke: true,
    });
  }

  const tLen = Math.hypot(tx, ty) || 1;
  const tux = tx / tLen;
  const tuy = ty / tLen;
  const tip = generator.linearPath(
    [
      [x2 - tux * 7 - tuy * 4.1, y2 - tuy * 7 + tux * 4.1],
      [x2, y2],
      [x2 - tux * 7 + tuy * 4.1, y2 - tuy * 7 - tux * 4.1],
    ],
    { seed: s + 7, roughness: 0.65, disableMultiStroke: true },
  );
  return `${drawableToSvgPath(body)} ${drawableToSvgPath(tip)}`;
}

/**
 * Deterministic Rough.js explanatory diagram rendered inside note cards.
 * Supports freeform `canvas` vector sketches + 8 diverse structural presets.
 */
export function buildSketchDiagram(sketch: AnnotationSketch, seed: string): SketchDiagramData {
  const s = seedInt(`sk:${seed}:${sketch.kind}`);
  const nodes = sketch.nodes.slice(0, 5);
  const fillPaths: string[] = [];
  const strokePaths: string[] = [];
  const dashedPaths: string[] = [];
  const accentPaths: string[] = [];
  const dots: SketchDot[] = [];
  const labels: SketchLabel[] = [];

  if (sketch.kind === "canvas" && sketch.elements && sketch.elements.length > 0) {
    let minX = 360;
    let minY = 220;
    let maxX = 0;
    let maxY = 0;
    const expand = (x: number, y: number) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };

    sketch.elements.forEach((el, i) => {
      const es = s + i * 29;
      if (el.type === "rect") {
        expand(el.x, el.y);
        expand(el.x + el.w, el.y + el.h);
        if (el.fill) fillPaths.push(softWashQuad(el.x, el.y, el.w, el.h));
        const d = drawableToSvgPath(
          generator.rectangle(el.x, el.y, el.w, el.h, {
            seed: es,
            roughness: 0.85,
            disableMultiStroke: true,
          }),
        );
        (el.dashed ? dashedPaths : strokePaths).push(d);
        if (el.label) {
          labels.push({
            x: el.x + el.w / 2,
            y: el.y + el.h / 2,
            lines: wrapSketchText(el.label, Math.max(7, el.w / 8.5)),
            align: "middle",
            size: el.w >= 95 ? "md" : "sm",
          });
        }
      } else if (el.type === "ellipse") {
        expand(el.x - el.rx, el.y - el.ry);
        expand(el.x + el.rx, el.y + el.ry);
        if (el.fill) fillPaths.push(ellipseWashPath(el.x, el.y, el.rx, el.ry));
        const d = drawableToSvgPath(
          generator.ellipse(el.x, el.y, el.rx * 2, el.ry * 2, {
            seed: es,
            roughness: 0.85,
            disableMultiStroke: true,
          }),
        );
        (el.dashed ? dashedPaths : strokePaths).push(d);
        if (el.label) {
          labels.push({
            x: el.x,
            y: el.y,
            lines: wrapSketchText(el.label, Math.max(7, (el.rx * 2) / 9)),
            align: "middle",
            size: el.rx >= 42 ? "md" : "sm",
          });
        }
      } else if (el.type === "arrow") {
        const bend = el.bend ?? 0;
        expand(el.x1, el.y1);
        expand(el.x2, el.y2);
        if (Math.abs(bend) > 1) {
          const dx = el.x2 - el.x1;
          const dy = el.y2 - el.y1;
          const len = Math.hypot(dx, dy) || 1;
          expand((el.x1 + el.x2) / 2 - (dy / len) * bend * 0.8, (el.y1 + el.y2) / 2 + (dx / len) * bend * 0.8);
        }
        const d = sketchArrow(el.x1, el.y1, el.x2, el.y2, es, bend);
        (el.dashed ? dashedPaths : accentPaths).push(d);
        if (el.label) {
          const dx = el.x2 - el.x1;
          const dy = el.y2 - el.y1;
          const len = Math.hypot(dx, dy) || 1;
          const mx = (el.x1 + el.x2) / 2 - (dy / len) * (bend * 0.65 || 12);
          const my = (el.y1 + el.y2) / 2 + (dx / len) * (bend * 0.65 || 12) - 4;
          expand(mx - 24, my - 10);
          expand(mx + 24, my + 10);
          labels.push({
            x: mx,
            y: my,
            lines: wrapSketchText(el.label, 14),
            align: "middle",
            size: "sm",
          });
        }
      } else if (el.type === "line") {
        expand(el.x1, el.y1);
        expand(el.x2, el.y2);
        const d = drawableToSvgPath(
          generator.line(el.x1, el.y1, el.x2, el.y2, {
            seed: es,
            roughness: 0.78,
            disableMultiStroke: true,
          }),
        );
        (el.dashed ? dashedPaths : strokePaths).push(d);
        if (el.label) {
          const mx = (el.x1 + el.x2) / 2;
          const my = (el.y1 + el.y2) / 2 - 10;
          expand(mx - 24, my - 10);
          expand(mx + 24, my + 8);
          labels.push({
            x: mx,
            y: my,
            lines: wrapSketchText(el.label, 14),
            align: "middle",
            size: "sm",
          });
        }
      } else if (el.type === "curve") {
        for (const [px, py] of el.points) expand(px, py);
        const pts = el.closed && el.points.length >= 3 ? [...el.points, el.points[0]] : el.points;
        if (el.fill && el.points.length >= 3) {
          fillPaths.push(polygonPath(el.points, true));
        }
        const d = drawableToSvgPath(
          generator.curve(pts as Array<[number, number]>, {
            seed: es,
            roughness: 0.78,
            bowing: 0.75,
            disableMultiStroke: true,
          }),
        );
        if (el.dashed) dashedPaths.push(d);
        else accentPaths.push(d);
        if (el.label && el.points.length > 0) {
          const mid = el.points[Math.floor(el.points.length / 2)];
          expand(mid[0] - 24, mid[1] - 18);
          expand(mid[0] + 24, mid[1] + 6);
          labels.push({
            x: mid[0],
            y: mid[1] - 12,
            lines: wrapSketchText(el.label, 14),
            align: "middle",
            size: "sm",
          });
        }
      } else if (el.type === "dot") {
        expand(el.x - 6, el.y - 6);
        expand(el.x + 6, el.y + 6);
        dots.push({ x: el.x, y: el.y, r: 4.5 });
        if (el.label) {
          const ly = el.y < 32 ? el.y + 18 : el.y - 12;
          expand(el.x - 30, ly - 10);
          expand(el.x + 30, ly + 10);
          labels.push({
            x: el.x,
            y: ly,
            lines: wrapSketchText(el.label, 14),
            align: "middle",
            size: "sm",
          });
        }
      } else if (el.type === "text") {
        const lines = wrapSketchText(el.text, 18);
        const halfW = Math.min(85, Math.max(24, lines[0].length * 7));
        expand(el.x - (el.align === "start" ? 4 : halfW), el.y - 14);
        expand(el.x + (el.align === "end" ? 4 : halfW), el.y + (lines.length > 1 ? 16 : 6));
        labels.push({
          x: el.x,
          y: el.y,
          lines,
          align: el.align ?? "middle",
          size: el.size ?? "md",
        });
      }
    });

    if (minX > maxX) {
      return { minX: 0, minY: 0, width: 320, height: 140, fillPaths, strokePaths, dashedPaths, accentPaths, dots, labels };
    }
    const padX = 20;
    const padY = 18;
    const vbX = Math.max(0, Math.floor(minX - padX));
    const vbY = Math.max(0, Math.floor(minY - padY));
    const vbW = Math.max(220, Math.ceil(maxX + padX - vbX));
    const vbH = Math.max(96, Math.ceil(maxY + padY - vbY));
    return {
      minX: vbX,
      minY: vbY,
      width: vbW,
      height: vbH,
      fillPaths,
      strokePaths,
      dashedPaths,
      accentPaths,
      dots,
      labels,
    };
  }

  const width = 360;

  if (sketch.kind === "cycle") {
    const height = 186;
    const cx = 180;
    const cy = 94;
    const n = Math.max(2, nodes.length);
    const ringRx = n <= 3 ? 104 : 114;
    const ringRy = n === 2 ? 0 : 54;
    const nodeRx = n <= 3 ? 52 : 46;
    const nodeRy = 22;

    const centers = nodes.map((_, i) => {
      const angle = -Math.PI / 2 + (i / n) * Math.PI * 2;
      return [cx + Math.cos(angle) * ringRx, cy + Math.sin(angle) * ringRy] as const;
    });

    centers.forEach(([nx, ny], i) => {
      if (i % 2 === 0) fillPaths.push(ellipseWashPath(nx, ny, nodeRx, nodeRy));
      strokePaths.push(
        drawableToSvgPath(
          generator.ellipse(nx, ny, nodeRx * 2, nodeRy * 2, {
            seed: s + i * 23,
            roughness: 0.85,
            disableMultiStroke: true,
          }),
        ),
      );
      labels.push({
        x: nx,
        y: ny,
        lines: wrapSketchText(nodes[i], 10),
        align: "middle",
        size: "md",
      });

      const [nextX, nextY] = centers[(i + 1) % n];
      const vx = nextX - nx;
      const vy = nextY - ny;
      const dist = Math.hypot(vx, vy) || 1;
      const trimStart = Math.min(dist * 0.32, nodeRx * 0.85);
      const trimEnd = Math.min(dist * 0.32, nodeRx * 0.85);
      const sx = nx + (vx / dist) * trimStart;
      const sy = ny + (vy / dist) * trimStart;
      const ex = nextX - (vx / dist) * trimEnd;
      const ey = nextY - (vy / dist) * trimEnd;
      accentPaths.push(sketchArrow(sx, sy, ex, ey, s + 200 + i, n === 2 ? (i === 0 ? -36 : 36) : 22));
    });
    return { minX: 0, minY: 0, width, height, fillPaths, strokePaths, dashedPaths, accentPaths, dots, labels };
  }

  if (sketch.kind === "tree") {
    const height = 166;
    const root = nodes[0] || "Root";
    const children = nodes.slice(1);
    const cCount = Math.max(1, children.length);
    const rootRx = 62;
    const rootRy = 22;
    const rootY = 34;

    fillPaths.push(ellipseWashPath(180, rootY, rootRx, rootRy));
    strokePaths.push(
      drawableToSvgPath(
        generator.ellipse(180, rootY, rootRx * 2, rootRy * 2, {
          seed: s + 11,
          roughness: 0.85,
          disableMultiStroke: true,
        }),
      ),
    );
    labels.push({ x: 180, y: rootY, lines: wrapSketchText(root, 12), align: "middle", size: "md" });

    const padX = 14;
    const gap = 12;
    const childW = Math.min(116, (width - padX * 2 - gap * (cCount - 1)) / cCount);
    const totalW = childW * cCount + gap * (cCount - 1);
    const startX = (width - totalW) / 2;
    const childY = 104;
    const childH = 44;

    children.forEach((child, i) => {
      const bx = startX + i * (childW + gap);
      const bcx = bx + childW / 2;
      accentPaths.push(sketchArrow(180, rootY + rootRy + 2, bcx, childY - 3, s + 80 + i, (bcx - 180) * 0.08));
      strokePaths.push(pillFramePath(bx, childY, childW, childH, s + 120 + i * 17));
      labels.push({
        x: bcx,
        y: childY + childH / 2,
        lines: wrapSketchText(child, cCount <= 2 ? 13 : 9.5),
        align: "middle",
        size: cCount <= 3 ? "md" : "sm",
      });
    });
    return { minX: 0, minY: 0, width, height, fillPaths, strokePaths, dashedPaths, accentPaths, dots, labels };
  }

  if (sketch.kind === "venn") {
    const height = 158;
    const rX = 82;
    const rY = 60;
    const cy = 79;
    const lx = 132;
    const rx = 228;

    fillPaths.push(ellipseWashPath(lx, cy, rX, rY));
    fillPaths.push(ellipseWashPath(rx, cy, rX, rY));
    strokePaths.push(
      drawableToSvgPath(
        generator.ellipse(lx, cy, rX * 2, rY * 2, { seed: s + 13, roughness: 0.88, disableMultiStroke: true }),
      ),
    );
    strokePaths.push(
      drawableToSvgPath(
        generator.ellipse(rx, cy, rX * 2, rY * 2, { seed: s + 37, roughness: 0.88, disableMultiStroke: true }),
      ),
    );

    if (nodes[0]) {
      labels.push({
        x: nodes[2] ? lx - 24 : lx - 10,
        y: cy,
        lines: wrapSketchText(nodes[0], 11),
        align: "middle",
        size: "md",
      });
    }
    if (nodes[1]) {
      labels.push({
        x: nodes[2] ? rx + 24 : rx + 10,
        y: cy,
        lines: wrapSketchText(nodes[1], 11),
        align: "middle",
        size: "md",
      });
    }
    if (nodes[2]) {
      labels.push({
        x: 180,
        y: cy,
        lines: wrapSketchText(nodes[2], 9),
        align: "middle",
        size: "sm",
      });
    }
    return { minX: 0, minY: 0, width, height, fillPaths, strokePaths, dashedPaths, accentPaths, dots, labels };
  }

  if (sketch.kind === "timeline") {
    const height = 148;
    const axisY = 74;
    accentPaths.push(sketchArrow(20, axisY, 340, axisY, s + 9));
    const n = Math.max(2, nodes.length);
    const spanStart = 52;
    const spanEnd = 308;

    nodes.forEach((node, i) => {
      const mx = n === 1 ? 180 : spanStart + (i / (n - 1)) * (spanEnd - spanStart);
      const above = i % 2 === 0;
      const tipY = above ? 34 : 114;
      dots.push({ x: mx, y: axisY, r: 4.5 });
      strokePaths.push(
        drawableToSvgPath(
          generator.line(mx, axisY, mx, above ? tipY + 12 : tipY - 12, {
            seed: s + 40 + i,
            roughness: 0.65,
            disableMultiStroke: true,
          }),
        ),
      );
      labels.push({
        x: mx,
        y: tipY,
        lines: wrapSketchText(node, 11),
        align: "middle",
        size: "md",
      });
    });
    return { minX: 0, minY: 0, width, height, fillPaths, strokePaths, dashedPaths, accentPaths, dots, labels };
  }

  if (sketch.kind === "flow") {
    if (nodes.length <= 3) {
      const height = 104;
      const n = Math.max(2, nodes.length);
      const padX = 10;
      const arrowW = n === 2 ? 44 : 24;
      const boxW = (width - padX * 2 - arrowW * (n - 1)) / n;
      const boxH = 54;
      const boxY = 25;
      const maxUnits = n === 2 ? 15 : 10.5;

      nodes.forEach((node, i) => {
        const bx = padX + i * (boxW + arrowW);
        if (i === 0 || i === n - 1) fillPaths.push(softWashQuad(bx + 4, boxY + 2, boxW - 8, boxH - 4));
        strokePaths.push(pillFramePath(bx, boxY, boxW, boxH, s + i * 17));
        labels.push({
          x: bx + boxW / 2,
          y: boxY + boxH / 2,
          lines: wrapSketchText(node, maxUnits),
          align: "middle",
          size: "md",
        });
        if (i < n - 1) {
          accentPaths.push(
            sketchArrow(bx + boxW + 3, boxY + boxH / 2, bx + boxW + arrowW - 3, boxY + boxH / 2, s + 100 + i, -6),
          );
        }
      });
      return { minX: 0, minY: 0, width, height, fillPaths, strokePaths, dashedPaths, accentPaths, dots, labels };
    }

    const height = 152;
    const boxW = 140;
    const boxH = 48;
    const positions: Array<[number, number]> = [
      [14, 14],
      [206, 14],
      [14, 90],
      [206, 90],
    ];
    nodes.slice(0, 4).forEach((node, i) => {
      const [bx, by] = positions[i];
      if (i === 0 || i === 3) fillPaths.push(softWashQuad(bx + 4, by + 2, boxW - 8, boxH - 4));
      strokePaths.push(pillFramePath(bx, by, boxW, boxH, s + i * 19));
      labels.push({
        x: bx + boxW / 2,
        y: by + boxH / 2,
        lines: wrapSketchText(node, 13),
        align: "middle",
        size: "md",
      });
    });
    accentPaths.push(sketchArrow(158, 38, 202, 38, s + 201));
    accentPaths.push(sketchArrow(232, 65, 128, 88, s + 202, 14));
    accentPaths.push(sketchArrow(158, 114, 202, 114, s + 203));
    return { minX: 0, minY: 0, width, height, fillPaths, strokePaths, dashedPaths, accentPaths, dots, labels };
  }

  if (sketch.kind === "compare") {
    const height = 114;
    const n = Math.max(2, Math.min(3, nodes.length));
    const padX = 10;
    const gap = 10;
    const colW = (width - padX * 2 - gap * (n - 1)) / n;
    const boxH = 82;
    const boxY = 16;
    const maxUnits = n === 2 ? 16 : 10.5;

    nodes.slice(0, n).forEach((node, i) => {
      const cx = padX + i * (colW + gap);
      if (i === n - 1) fillPaths.push(softWashQuad(cx, boxY, colW, boxH));
      if (i > 0) {
        dashedPaths.push(
          drawableToSvgPath(
            generator.line(cx - gap / 2, boxY + 6, cx - gap / 2, boxY + boxH - 6, {
              seed: s + i * 31,
              roughness: 0.75,
              disableMultiStroke: true,
            }),
          ),
        );
      }
      strokePaths.push(
        drawableToSvgPath(
          generator.line(cx + 12, boxY + 20, cx + colW - 12, boxY + 20, {
            seed: s + i * 29 + 5,
            roughness: 0.7,
            disableMultiStroke: true,
          }),
        ),
      );
      labels.push({
        x: cx + colW / 2,
        y: boxY + 54,
        lines: wrapSketchText(node, maxUnits),
        align: "middle",
        size: "md",
      });
    });
    return { minX: 0, minY: 0, width, height, fillPaths, strokePaths, dashedPaths, accentPaths, dots, labels };
  }

  if (sketch.kind === "layers") {
    const count = Math.max(2, nodes.length);
    const slabH = 34;
    const gap = 8;
    const topPad = 12;
    const height = topPad * 2 + count * slabH + (count - 1) * gap;
    const slabX = 24;
    const slabW = width - 48;

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
        lines: wrapSketchText(node, 26),
        align: "middle",
        size: "md",
      });
    });
    return { minX: 0, minY: 0, width, height, fillPaths, strokePaths, dashedPaths, accentPaths, dots, labels };
  }

  // axes (generous coordinates + shaded under-curve area)
  const height = 152;
  strokePaths.push(sketchArrow(38, 118, 38, 18, s + 11));
  strokePaths.push(sketchArrow(38, 118, 338, 118, s + 12));

  const shape = sketch.shape ?? "rise";
  const curvePts: Array<[number, number]> =
    shape === "drop"
      ? [
          [50, 26],
          [125, 52],
          [222, 88],
          [320, 106],
        ]
      : shape === "peak"
        ? [
            [50, 102],
            [125, 70],
            [186, 26],
            [248, 70],
            [320, 102],
          ]
        : shape === "threshold"
          ? [
              [50, 98],
              [158, 94],
              [194, 54],
              [238, 30],
              [320, 28],
            ]
          : [
              [50, 106],
              [130, 94],
              [224, 62],
              [320, 26],
            ];

  fillPaths.push(polygonPath([...curvePts, [320, 118], [50, 118]], true));
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
    const markerX = shape === "peak" ? 186 : 178;
    dashedPaths.push(
      drawableToSvgPath(
        generator.line(markerX, 24, markerX, 118, {
          seed: s + 53,
          roughness: 0.6,
          disableMultiStroke: true,
        }),
      ),
    );
    dots.push({ x: markerX, y: shape === "peak" ? 26 : 74, r: 4.5 });
  }

  if (nodes[0]) {
    labels.push({
      x: 42,
      y: 138,
      lines: wrapSketchText(nodes[0], 14),
      align: "start",
      size: "sm",
    });
  }
  if (nodes[1]) {
    labels.push({
      x: 336,
      y: 138,
      lines: wrapSketchText(nodes[1], 14),
      align: "end",
      size: "sm",
    });
  }
  if (nodes[2]) {
    labels.push({
      x: 188,
      y: 18,
      lines: wrapSketchText(nodes[2], 16),
      align: "middle",
      size: "md",
    });
  }
  return { minX: 0, minY: 0, width, height, fillPaths, strokePaths, dashedPaths, accentPaths, dots, labels };
}
