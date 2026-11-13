import { useMemo } from "react";
import type { AnnotationSketch, InkColor } from "../../shared/types";
import { buildSketchDiagram } from "../lib/ink-geometry";

export default function HandSketch({
  sketch,
  color,
  seed,
  compact = false,
}: {
  sketch: AnnotationSketch;
  color: InkColor;
  seed: string;
  compact?: boolean;
}) {
  const diagram = useMemo(() => buildSketchDiagram(sketch, seed), [sketch, seed]);

  return (
    <figure className={`hand-sketch pen-ink-${color} ${compact ? "is-compact" : ""}`}>
      <svg
        className="hand-sketch-svg"
        viewBox={`${diagram.minX} ${diagram.minY} ${diagram.width} ${diagram.height}`}
        aria-label={sketch.caption || `${sketch.kind} sketch diagram`}
      >
        {diagram.fillPaths.map((d, i) => (
          <path key={`f-${i}`} d={d} className={`hand-sketch-fill ink-fill-${color}`} />
        ))}
        {diagram.dashedPaths.map((d, i) => (
          <path key={`d-${i}`} d={d} className="hand-sketch-stroke is-dashed" />
        ))}
        {diagram.strokePaths.map((d, i) => (
          <path key={`s-${i}`} d={d} className="hand-sketch-stroke" />
        ))}
        {diagram.accentPaths.map((d, i) => (
          <path key={`a-${i}`} d={d} className="hand-sketch-accent" />
        ))}
        {diagram.dots.map((pt, i) => (
          <circle key={`pt-${i}`} cx={pt.x} cy={pt.y} r={pt.r} className="hand-sketch-dot" />
        ))}
        {diagram.labels.map((label, i) => {
          const lineCount = label.lines.length;
          const step = label.size === "lg" ? 16 : label.size === "sm" ? 13 : 15;
          const baseOffset = lineCount === 2 ? -Math.round(step * 0.42) : 4.5;
          const sizeClass = label.size === "lg" ? "is-lg" : label.size === "sm" ? "is-sm" : "is-md";
          return (
            <text
              key={`t-${i}`}
              x={label.x}
              y={label.y}
              textAnchor={label.align ?? "middle"}
              className={`hand-sketch-label ${sizeClass}`}
            >
              {label.lines.map((line, li) => (
                <tspan key={li} x={label.x} dy={li === 0 ? baseOffset : step}>
                  {line}
                </tspan>
              ))}
            </text>
          );
        })}
      </svg>
      {sketch.caption ? <figcaption className="hand-sketch-caption">{sketch.caption}</figcaption> : null}
    </figure>
  );
}
