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

/** Deterministic PRNG in [-1, 1] from string seed so hand-drawn strokes never flicker on re-render. */
export function seededJitter(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) / 2147483647.5) - 1;
  };
}

const fmt = (n: number) => Number(n.toFixed(1));

/** Organic chisel-tip highlighter wash path behind a single line rect. */
export function highlighterPath(rect: BoxRect, seed: string): string {
  const rand = seededJitter(`hl:${seed}`);
  const padX = 3;
  const x0 = rect.left - padX;
  const x1 = rect.left + rect.width + padX;
  const y0 = rect.top + 1 + rand() * 1.2;
  const y1 = rect.top + rect.height - 0.5 + rand() * 1.2;
  const midX = (x0 + x1) / 2;
  const skew = 2.2;
  return [
    `M ${fmt(x0 + skew)} ${fmt(y0)}`,
    `Q ${fmt(midX)} ${fmt(y0 + rand() * 1.6)} ${fmt(x1)} ${fmt(y0 + rand() * 1.1)}`,
    `L ${fmt(x1 - skew)} ${fmt(y1)}`,
    `Q ${fmt(midX)} ${fmt(y1 + rand() * 1.6)} ${fmt(x0)} ${fmt(y1 + rand() * 1.1)}`,
    "Z",
  ].join(" ");
}

/** Organic wavy / brush pen underline beneath a single line rect. */
export function wavyUnderlinePath(rect: BoxRect, seed: string): string {
  const rand = seededJitter(`ul:${seed}`);
  const x0 = rect.left - 1;
  const x1 = rect.left + rect.width + 2;
  const baseY = rect.top + rect.height + 1.5;
  const step = 14;
  const segments = Math.max(2, Math.round((x1 - x0) / step));
  const dx = (x1 - x0) / segments;
  let d = `M ${fmt(x0)} ${fmt(baseY + rand() * 0.8)}`;
  for (let i = 0; i < segments; i++) {
    const cx = x0 + (i + 0.5) * dx;
    const cy = baseY + (i % 2 === 0 ? -2.3 : 2.3) + rand() * 0.7;
    const ex = x0 + (i + 1) * dx;
    const ey = baseY + rand() * 0.8;
    d += ` Q ${fmt(cx)} ${fmt(cy)} ${fmt(ex)} ${fmt(ey)}`;
  }
  return d;
}

/** Double-pass hand-sketched ink loop / box around a text rect. */
export function handBoxPath(rect: BoxRect, seed: string): string {
  const rand = seededJitter(`bx:${seed}`);
  const padX = 4;
  const padY = 2.5;
  const x0 = rect.left - padX;
  const y0 = rect.top - padY;
  const x1 = rect.left + rect.width + padX;
  const y1 = rect.top + rect.height + padY;
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  return [
    `M ${fmt(x0 + 2)} ${fmt(y0 + rand() * 1.2)}`,
    `Q ${fmt(mx)} ${fmt(y0 - 1.8 + rand() * 1.2)} ${fmt(x1 - 1)} ${fmt(y0 + 1 + rand() * 1.2)}`,
    `Q ${fmt(x1 + 2.2)} ${fmt(my)} ${fmt(x1 - 1)} ${fmt(y1 - 1 + rand() * 1.2)}`,
    `Q ${fmt(mx)} ${fmt(y1 + 2 + rand() * 1.2)} ${fmt(x0 + 1)} ${fmt(y1 - 0.5 + rand() * 1.2)}`,
    `Q ${fmt(x0 - 2.2)} ${fmt(my)} ${fmt(x0 + 4)} ${fmt(y0 - 0.8 + rand() * 1.2)}`,
  ].join(" ");
}

/** Hand-drawn margin curly/square bracket along the right edge of a block bounding box. */
export function bracketPath(bounds: BoxRect, seed: string): string {
  const rand = seededJitter(`br:${seed}`);
  const x = bounds.left + bounds.width + 8;
  const y0 = bounds.top - 2;
  const y1 = bounds.top + bounds.height + 2;
  const ym = (y0 + y1) / 2;
  return [
    `M ${fmt(x - 5)} ${fmt(y0 + rand())}`,
    `Q ${fmt(x + 2)} ${fmt(y0)} ${fmt(x + 1)} ${fmt(y0 + 7)}`,
    `Q ${fmt(x + 1 + rand() * 1.2)} ${fmt((y0 + ym) / 2)} ${fmt(x + 6)} ${fmt(ym)}`,
    `Q ${fmt(x + 1 + rand() * 1.2)} ${fmt((ym + y1) / 2)} ${fmt(x + 1)} ${fmt(y1 - 7)}`,
    `Q ${fmt(x + 2)} ${fmt(y1)} ${fmt(x - 5)} ${fmt(y1 + rand())}`,
  ].join(" ");
}

/** Hand-drawn curved leader line + arrowhead connecting anchor (ax, ay) to margin note (nx, ny). */
export function leaderArrowPath(ax: number, ay: number, nx: number, ny: number, seed: string): string {
  const rand = seededJitter(`ld:${seed}`);
  const spanX = Math.max(24, nx - ax);
  const c1x = ax + spanX * 0.42;
  const c1y = ay + (ny - ay) * 0.14 + rand() * 4;
  const c2x = nx - spanX * 0.32;
  const c2y = ny - (ny - ay) * 0.08 + rand() * 3;
  const curve = `M ${fmt(ax)} ${fmt(ay)} C ${fmt(c1x)} ${fmt(c1y)}, ${fmt(c2x)} ${fmt(c2y)}, ${fmt(nx)} ${fmt(ny)}`;
  const head = `M ${fmt(nx - 6.5)} ${fmt(ny - 3.8)} L ${fmt(nx)} ${fmt(ny)} L ${fmt(nx - 6.2)} ${fmt(ny + 4.1)}`;
  return `${curve} ${head}`;
}

/** Stacks margin notes vertically without overlap while staying as close as possible to desiredTop. */
export function layoutMarginNotes(slots: readonly MarginNoteSlot[], gap = 12): PositionedMarginNote[] {
  const ordered = [...slots].sort((a, b) => a.desiredTop - b.desiredTop);
  let cursor = 0;
  return ordered.map((slot) => {
    const top = Math.max(cursor, Math.max(0, Math.round(slot.desiredTop)));
    cursor = top + Math.max(40, Math.round(slot.height)) + gap;
    return { id: slot.id, top };
  });
}
