import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSketchDiagram } from "./ink-geometry";
import type { AnnotationSketch } from "../../shared/types";

test("buildSketchDiagram generates deterministic Rough.js geometry for all 9 kinds including canvas", () => {
  const cases: AnnotationSketch[] = [
    { kind: "flow", nodes: ["Input", "Parse", "IR"] },
    { kind: "flow", nodes: ["Lex", "Parse", "Typecheck", "Emit"] },
    { kind: "compare", nodes: ["CPU 循序", "GPU 平行"] },
    { kind: "layers", nodes: ["App", "Runtime", "Kernel"] },
    { kind: "axes", nodes: ["樣本數", "誤差率", "甜蜜點"], shape: "peak" },
    { kind: "cycle", nodes: ["Macrotask", "Stack", "Microtask", "Render"] },
    { kind: "tree", nodes: ["CSG 運算", "交集 max", "聯集 min", "差集"] },
    { kind: "venn", nodes: ["外部 d>0", "內部 d<0", "表面 d=0"] },
    { kind: "timeline", nodes: ["Fetch", "Decode", "Execute", "Commit"] },
    {
      kind: "canvas",
      nodes: [],
      elements: [
        { type: "ellipse", x: 180, y: 95, rx: 52, ry: 52, fill: true, dashed: true, label: "d=0" },
        { type: "dot", x: 72, y: 95, label: "p" },
        { type: "arrow", x1: 78, y1: 95, x2: 126, y2: 95, label: "距離 d" },
        { type: "curve", points: [[30, 140], [110, 110], [250, 155]] },
      ],
    },
  ];

  for (const sketch of cases) {
    const a = buildSketchDiagram(sketch, "seed-1");
    const b = buildSketchDiagram(sketch, "seed-1");
    assert.deepEqual(a, b, `expected deterministic geometry for ${sketch.kind}`);
    const totalPaths = a.strokePaths.length + a.dashedPaths.length + a.accentPaths.length;
    assert.ok(totalPaths > 0, `expected Rough paths for ${sketch.kind}`);
    assert.ok(a.width >= 220 && a.height >= 96, `expected generous viewBox for ${sketch.kind}`);
    assert.ok(a.labels.length >= 2, `expected readable labels for ${sketch.kind}`);
  }
});
