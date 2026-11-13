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
        viewBox={`0 0 ${diagram.width} ${diagram.height}`}
        aria-label={sketch.caption || `${sketch.kind} sketch diagram`}
      >
        {diagram.fillPaths.map((d, i) => (
          <path key={`f-${i}`} d={d} className={`hand-sketch-fill ink-fill-${color}`} />
        ))}
        {diagram.strokePaths.map((d, i) => (
          <path key={`s-${i}`} d={d} className="hand-sketch-stroke" />
        ))}
        {diagram.accentPaths.map((d, i) => (
          <path key={`a-${i}`} d={d} className="hand-sketch-accent" />
        ))}
        {diagram.labels.map((label, i) => {
          const lineCount = label.lines.length;
          const baseOffset = lineCount === 2 ? -5 : 3.5;
          return (
            <text
              key={`t-${i}`}
              x={label.x}
              y={label.y}
              textAnchor={label.align ?? "middle"}
              className={`hand-sketch-label ${label.small ? "is-small" : ""}`}
            >
              {label.lines.map((line, li) => (
                <tspan key={li} x={label.x} dy={li === 0 ? baseOffset : 12}>
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
