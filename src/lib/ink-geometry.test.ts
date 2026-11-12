import test from "node:test";
import assert from "node:assert/strict";
import {
  bracketPath,
  handBoxPath,
  handPinCirclePath,
  highlighterPath,
  layoutMarginNotes,
  leaderArrowPath,
  wavyUnderlinePath,
} from "./ink-geometry.js";
import {
  explainDraftHref,
  parseReaderHandoff,
} from "../../shared/suite.js";

test("Rough.js & perfect-freehand paths are deterministic and valid SVG path strings", () => {
  const rect = { left: 40, top: 120, width: 180, height: 22 };
  const shortRect = { left: 40, top: 120, width: 84, height: 22 };
  const p1 = highlighterPath(rect, "ann-1:0");
  const p2 = highlighterPath(rect, "ann-1:0");
  assert.equal(p1, p2);
  assert.ok(p1.startsWith("M ") && p1.endsWith("Z"));
  assert.ok(wavyUnderlinePath(rect, "ann-1:0").includes("C"));
  assert.equal(wavyUnderlinePath(rect, "ann-1:0"), wavyUnderlinePath(rect, "ann-1:0"));
  assert.ok(handBoxPath(rect, "ann-1:0").startsWith("M"));
  assert.ok(handBoxPath(shortRect, "ann-1:1").includes("C"));
  assert.ok(handPinCirclePath(120, 90, 13, "img-1").includes("C"));
  assert.equal(handPinCirclePath(120, 90, 13, "img-1"), handPinCirclePath(120, 90, 13, "img-1"));
  assert.ok(bracketPath(rect, "ann-1").includes("C"));
  assert.ok(leaderArrowPath(220, 130, 720, 145, "ann-1").includes("C"));
});

test("layoutMarginNotes prevents vertical overlaps while preserving order", () => {
  const placed = layoutMarginNotes(
    [
      { id: "a", desiredTop: 100, height: 90 },
      { id: "b", desiredTop: 120, height: 80 },
      { id: "c", desiredTop: 400, height: 70 },
    ],
    12,
  );
  assert.deepEqual(placed, [
    { id: "a", top: 100 },
    { id: "b", top: 202 }, // 100 + 90 + 12
    { id: "c", top: 400 },
  ]);
});

test("Suite reader handoff enforces single-key rule, linked source check, and safe back routes", () => {
  const links = {
    explain: "http://127.0.0.1:21101",
    personal: "http://127.0.0.1:21103",
  };
  const ok = parseReaderHandoff(
    "#/read?text=Hello+world&title=Demo&from=explain&back=%23%2Fnote%2Fabc-1",
    links,
  );
  assert.equal(ok.present, true);
  if (ok.present && ok.draft) {
    assert.equal(ok.draft.from, "explain");
    assert.equal(ok.draft.text, "Hello world");
    assert.equal(ok.draft.backUrl, "http://127.0.0.1:21101/#/note/abc-1");
  }

  const dup = parseReaderHandoff("#/read?text=a&from=explain&from=personal", links);
  assert.deepEqual(dup, { present: true, rejected: "duplicate" });

  const evilBack = parseReaderHandoff("#/read?text=hi&from=explain&back=https://evil.example", links);
  assert.equal(evilBack.present && evilBack.draft?.backUrl, undefined);

  const toExplain = explainDraftHref(
    "http://127.0.0.1:21101",
    { text: "重點內容", title: "Event Loop", back: "#/page/page-123" },
    "127.0.0.1",
  );
  assert.ok(toExplain?.startsWith("http://127.0.0.1:21101/#/explain?"));
  assert.ok(toExplain?.includes("from=reader"));
});
