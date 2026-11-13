import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSketchDiagram } from "./ink-geometry";
import type { AnnotationSketch } from "../../shared/types";

test("buildSketchDiagram generates deterministic Rough.js geometry for all 4 kinds", () => {
  const cases: AnnotationSketch[] = [
    { kind: "flow", nodes: ["Input", "Parse", "IR"] },
    { kind: "flow", nodes: ["Lex", "Parse", "Typecheck", "Emit"] },
    { kind: "compare", nodes: ["CPU 循序", "GPU 平行"] },
    { kind: "layers", nodes: ["App", "Runtime", "Kernel"] },
    { kind: "axes", nodes: ["樣本數", "誤差率", "甜蜜點"], shape: "peak" },
  ];

  for (const sketch of cases) {
    const a = buildSketchDiagram(sketch, "seed-1");
    const b = buildSketchDiagram(sketch, "seed-1");
    assert.deepEqual(a, b, `expected deterministic geometry for ${sketch.kind}`);
    assert.ok(a.strokePaths.length > 0, `expected strokePaths for ${sketch.kind}`);
    assert.ok(
      a.strokePaths.every((d) => d.startsWith("M")),
      `expected SVG path commands for ${sketch.kind}`,
    );
    assert.equal(a.labels.length, sketch.nodes.length);
  }
});
