import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Response as UndiciResponse } from "undici";
import { createApp } from "./app.js";
import { AppError } from "./errors.js";
import { createPinnedLookup, extractBlocksFromPdf, fetchPublicPageSource, validatePublicUrl } from "./extractor.js";
import {
  buildDeterministicSimulation,
  buildDeterministicStepper,
  extractPassageSignals,
  sanitizeSimulationHtml,
} from "./interactive.js";
import { ReaderStore } from "./store.js";
import { SUITE_LIMITS } from "../shared/suite.js";

function listenLocal(app: ReturnType<typeof createApp>): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function makeMinimalPdf(streamBody: string): Buffer {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(streamBody, "latin1")} >>\nstream\n${streamBody}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += obj;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

test("PDF extraction supports Ghostscript, pure-JS fallback, and scanned empty PDFs", async () => {
  const pdfWithText = makeMinimalPdf("BT /F1 14 Tf 72 720 Td (Frame budget is 16.6ms in browser) Tj ET");
  const gsExtracted = await extractBlocksFromPdf(pdfWithText, "render-pipeline.pdf");
  assert.equal(gsExtracted.title, "render-pipeline");
  assert.equal(gsExtracted.pageCount, 1);
  assert.ok(gsExtracted.blocks.some((b) => b.text.includes("16.6ms")));

  // Force pure-JS fallback by pointing GS_BIN to a nonexistent path
  const prevGs = process.env.GS_BIN;
  process.env.GS_BIN = "/nonexistent/gs-binary";
  try {
    const jsExtracted = await extractBlocksFromPdf(pdfWithText, "fallback.pdf");
    assert.ok(jsExtracted.blocks.some((b) => b.text.includes("16.6ms")));

    const scannedPdf = makeMinimalPdf("");
    const scannedExtracted = await extractBlocksFromPdf(scannedPdf, "scanned-doc.pdf");
    assert.equal(scannedExtracted.blocks.length, 1);
    assert.ok(scannedExtracted.blocks[0].text.includes("左側 PDF 原檔"));
  } finally {
    if (prevGs === undefined) delete process.env.GS_BIN;
    else process.env.GS_BIN = prevGs;
  }
});

function decodeSimPayload(html: string): string {
  const m = html.match(/atob\("([A-Za-z0-9+/=]+)"\)/);
  assert.ok(m, "expected base64-encoded payload in deterministic simulation");
  return Buffer.from(m[1], "base64").toString("utf8");
}

test("Deterministic interactive blocks are passage-driven and sanitizer blocks unsafe HTML/APIs", () => {
  const numSim = buildDeterministicSimulation({
    block: {
      id: "b1",
      kind: "paragraph",
      text: "The rendering pipeline targets 16.6ms per frame at 60Hz with 25ms max task latency.",
    },
    pageTitle: "Frame Budget",
  });
  assert.ok(decodeSimPayload(numSim.html).includes("16.6"));
  assert.ok(decodeSimPayload(numSim.html).includes("60"));

  const codeSim = buildDeterministicSimulation({
    block: {
      id: "b2",
      kind: "code",
      language: "ts",
      text: "const chunk = items.splice(0, 42);\nrequestAnimationFrame(() => flush(chunk));",
    },
    pageTitle: "Batch Flush",
  });
  assert.ok(decodeSimPayload(codeSim.html).includes("items.splice(0, 42)"));
  assert.notEqual(numSim.html, codeSim.html);

  const tableSim = buildDeterministicSimulation({
    block: {
      id: "b3",
      kind: "table",
      text: "Tier | Latency\nL1Cache | 1ns\nDRAM | 80ns",
      tableRows: [
        ["Tier", "Latency"],
        ["L1Cache", "1ns"],
        ["DRAM", "80ns"],
      ],
    },
    pageTitle: "Memory Hierarchy",
  });
  assert.ok(decodeSimPayload(tableSim.html).includes("L1Cache"));
  assert.ok(decodeSimPayload(tableSim.html).includes("DRAM"));

  const stepper = buildDeterministicStepper({
    block: {
      id: "b4",
      kind: "paragraph",
      text: "Microtask queue drains completely before paint. Long tasks exceeding 50ms cause dropped frames.",
    },
    pageTitle: "Event Loop",
  });
  assert.ok(stepper.steps.length >= 2);
  assert.ok(stepper.checks.length >= 1);
  for (const chk of stepper.checks) {
    assert.ok(chk.correctIndex >= 0 && chk.correctIndex < chk.options.length);
  }

  for (const unsafe of [
    '<iframe src="/x"></iframe>',
    "<object data='x'></object>",
    "<form action='/steal'><input /></form>",
    '<img src="https://evil.test/track.png" />',
    "<img src=https://evil.test/track.png>",
    "<svg onload=alert(1)></svg>",
    "<svg/onload=alert(1)></svg>",
    '<div title="a > b" onclick=alert(1)>hi</div>',
    '<div title="a > b"onclick=alert(1)>hi</div>',
    '<a href="javascript:alert(1)">click</a>',
    '<a href="&#104;ttps://evil.test">click</a>',
    '<a href="javascript&colon;alert(1)">click</a>',
    "<script>fetch('/api/pages')</script>",
    "<script>fetch?.('/api/pages')</script>",
    "<script>new XMLHttpRequest()</script>",
    "<script>localStorage.getItem('x')</script>",
    "<script>window.parent.postMessage('x', '*')</script>",
    "<script>window['open']('https://evil.test')</script>",
    "<script>window['fetch']('/api/pages')</script>",
    "<script>self['parent'].postMessage('x','*')</script>",
    "<script>self?.['parent'].postMessage('x','*')</script>",
    "<script>window?.['open']('https://evil.test')</script>",
    "<script>window?.open('https://evil.test')</script>",
    "<script>globalThis?.['fetch']('/api/pages')</script>",
    "<script>document?.['cookie']</script>",
    "<script>window\n.open('https://evil.test')</script>",
    "<script>document\n.cookie</script>",
    "<script>frames[0].postMessage('x','*')</script>",
    "<script>top?.location?.assign('https://evil.test')</script>",
    "<div>hi</div></script><script>alert(1)</script>",
    "<script>var x = '</script><script>alert(1)</script>'</script>",
    // Unmatched quotes / malformed tags / HTML5 entities / foreign content / CSS & JS obfuscations
    '<img src=x" onerror=alert(1)>',
    "<img src=x' onerror=alert(1)>",
    '<svg id=a\' onload="alert(1)"></svg>',
    '<svg onload=alert(1) data-x=">',
    '<svg onload=alert(1) data-x="><div class="foo">',
    '<img src="https://evil.test/x.png" data-x=">',
    '<div onclick=alert(1)//">hi</div>',
    '<div title="a" " onclick=alert(1)>',
    '<meta content=">" name=x" http-equiv=refresh>',
    "<div data-x=\"1\" data-y=2' onclick=alert(1)>x</div>",
    '<a href="java&Tab;script:alert(1)">click</a>',
    '<a href="java&NewLine;script:alert(1)">click</a>',
    '<img srcset="https://evil.test/a.png 1x, #ok 2x">',
    '<a href="#ok" ping="https://evil.test">go</a>',
    '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
    '<svg><use href="https://evil.test/a.svg#x"/></svg>',
    '<math><mi href="javascript:alert(1)">x</mi></math>',
    "<template><img src=x onerror=alert(1)></template>",
    "<noscript><img src=x onerror=alert(1)></noscript>",
    '<svg><set attributeName="onload" to="alert(1)"/></svg>',
    '<script src="data:image/png;base64,AA=="></script>',
    '<style>body{background:url(/*x*/"https://evil.test/a.png")}</style>',
    '<style>@import /*x*/ "https://evil.test/a.css";</style>',
    "<style>body{background:url(\\68 ttps://evil.test/a.png)}</style>",
    "<div style=\"background:url(/*x*/'https://evil.test/a.png')\">hi</div>",
    '<script>window ?.open("https://evil.test")</script>',
    "<script>document ?.cookie</script>",
    '<script>fetch ?.("/api/pages")</script>',
    "<script>self ?.['parent']</script>",
    "<script>top ?.location</script>",
    '<script>window/**/.open("https://evil.test")</script>',
    "<script>document/*a*/./*b*/cookie</script>",
    '<script>fetch/**/.name; fetch/**/("/api/pages")</script>',
    '<script>window//x\n.open("https://evil.test")</script>',
    '<script>var r = /"/; window/**/.open("https://evil.test")</script>',
    '<script>var s = "//"; window.open("https://evil.test")</script>',
    '<script>var t = `${window/**/.open("https://evil.test")}`;</script>',
    '<script>Reflect.get(self, "parent")</script>',
    "<script>Reflect ?.['get'](self, 'parent')</script>",
    '<script>new Function("alert(1)")()</script>',
    '<script>new /*x*/ Function("alert(1)")()</script>',
    '<script>Function("alert(1)")()</script>',
    '<script>import("/api/pages")</script>',
    '<script>import /*x*/ ("/api/pages")</script>',
    '<script>[].filter.constructor("alert(1)")()</script>',
    '<script>""["constructor"]</script>',
    "<script>var { open, fetch } = window</script>",
    "<script>const { cookie } = document</script>",
    "<script>var w = window</script>",
    '<script>const f = fetch; f("/api/pages")</script>',
    '<script>eval("alert(1)")</script>',
    '<script>(0, eval)("alert(1)")</script>',
    '<script>win\\u0064ow.open("https://evil.test")</script>',
    // Iteration 5 bypass vectors (control-flow regex-after-')', aliasing, tagged templates, string concat, image-set, SVG href)
    '<script>if (1) /"/; window/**/.open("https://evil.test")</script>',
    '<script>if ((1)) /"/; window/**/.open("https://evil.test")</script>',
    '<script>while (0) /"/; fetch/**/("/api/pages")</script>',
    '<script>for (;;) /"/; window/**/.open("https://evil.test")</script>',
    '<script>if (1) /"/; eval/**/("alert(1)")</script>',
    '<script>if (1) /"/; import/**/("/api/pages")</script>',
    '<script>const d = document; d.cookie</script>',
    '<script>const s = self; s["open"]("https://evil.test")</script>',
    '<script>const w = 0 || window; w.open("https://evil.test")</script>',
    '<script>const w = true ? window : null; w.open("https://evil.test")</script>',
    '<script>const w = (function(){ return window; })(); w.open("https://evil.test")</script>',
    '<script>const f = frames; f[0].postMessage("x","*")</script>',
    '<script>var { cookie } = (document);</script>',
    '<script>var { open } = (top);</script>',
    '<script>fetch`/api/pages`</script>',
    '<script>Function`alert(1)`()</script>',
    '<script>(1, eval)("alert(1)")</script>',
    '<script>(0, fetch)("/api/pages")</script>',
    '<script>const f = 0 || fetch; f("/api/pages")</script>',
    '<script>[]["constr" + "uctor"]("alert(1)")()</script>',
    '<script>location.href = "https://evil.test"</script>',
    '<script>open("https://evil.test")</script>',
    '<style>body{background-image:image-set("https://evil.test/a.png" 1x)}</style>',
    "<div style=\"background-image:image-set('https://evil.test/a.png' 1x)\">hi</div>",
    '<a href="data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' onload=\'alert(1)\'/>">go</a>',
    '<svg><use href="data:image/svg+xml;utf8,<svg id=\'x\'/>#x"/></svg>',
    // Iteration 6 AST & mXSS regression vectors
    '<script>{} / 2; fetch("/api/pages")</script>',
    '<script>function(){} / 2; fetch("/api/pages")</script>',
    '<script>of / 2; fetch("/api/pages")</script>',
    '<script>await / 2; fetch("/api/pages")</script>',
    '<script>document.body.ownerDocument.defaultView.open("https://evil.test")</script>',
    '<script>document.documentElement.parentNode.cookie</script>',
    '<script>Object.getPrototypeOf([])</script>',
    '<script>parent.postMessage("x", "*")</script>',
    '<script>top.postMessage("x", "*")</script>',
    '<script>var top = 10; top.postMessage("x", "*")</script>',
    '<script>location.assign("https://evil.test")</script>',
    '<script>const obj = { fetch }; obj.fetch("/api/pages")</script>',
    '<script>const { constructor: F } = [].filter; F("alert(1)")()</script>',
    '<script>const { fetch } = this</script>',
    '<script>const { ["\\x63onstructor"]: F } = [].filter</script>',
    '<script>[]["\\x63onstructor"]("alert(1)")()</script>',
    '<script>[][`con${""}structor`]("alert(1)")()</script>',
    '<script>const k = "con" + "structor"; [][k]("alert(1)")()</script>',
    '<script>let k; k = "constructor"; [][k]("alert(1)")()</script>',
    '<script>let k = "length"; if (1) { k = "constructor"; } else { k = "length"; } [][k]</script>',
    '<script>[][["con","structor"].join("")]("alert(1)")()</script>',
    '<script>setTimeout("alert(1)", 0)</script>',
    '<script>this.fetch("/api/pages")</script>',
    '<script>class A { m() { return (function(){ return this; })(); } }</script>',
    '<script>ev\\u0061l("1")</script>',
    '<script>import.meta</script>',
    '<script>with ({}) {}</script>',
    '<script type="module">fetch("/api/pages")</script>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
    '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
    // Iteration 7 AST, DOM sink, mXSS tag, and scope/destructuring bypass vectors
    '<noembed><img src=x onerror=alert(1)></noembed>',
    '<noframes><img src=x onerror=alert(1)></noframes>',
    '<xmp><img src=x onerror=alert(1)></xmp>',
    '<div class="sim-wrap"><script>var s = document.createElement("script"); s.textContent = "parent.postMessage(1,\\"*\\")"; document.body.appendChild(s);</script></div>',
    '<script>document.createElementNS("http://www.w3.org/1999/xhtml", "script")</script>',
    '<script>const ce = document.createElement; ce("div")</script>',
    '<div class="sim-wrap"><script>document.body.insertAdjacentHTML("beforeend", "<img src=x onerror=alert(1)>");</script></div>',
    '<script>document.body.outerHTML = "<img src=x onerror=alert(1)>"</script>',
    '<script>var el = document.createElement("div"); el.srcdoc = "<script>alert(1)</script>";</script>',
    '<script>if (1) { var k = "constructor"; } [][k]("alert(1)")()</script>',
    '<script>let k = "con"; k += "structor"; [][k]("alert(1)")()</script>',
    '<script>function f() { return [][k]; } const k = "constructor";</script>',
    '<script>let k = 0; function f() { return [][k]; } k = "constructor";</script>',
    '<script>function f(a = parent) { var parent = 1; return a; } f();</script>',
    '<script>function f(a = () => fetch) { var fetch = 1; return a(); } f()("/api/pages");</script>',
    '<script>const [k] = ["constructor"]; const F = []["map"][k]; F("return 1")();</script>',
    '<script>const [k] = ["constructor"]; const { [k]: F } = [].map;</script>',
    '<script>const { a: k } = { a: "constructor" }; const F = []["map"][k]; F("return 1")();</script>',
    '<script>let k; [k] = ["constructor"]; []["map"][k];</script>',
    '<script>const o = { a: "ownerDocument", b: "defaultView" }; const w = document.body[o.a][o.b];</script>',
    '<script>const o = { length: "constructor" }; []["map"][o.length]</script>',
    '<script>const k = 1 ? "constructor" : "x"; []["map"][k]</script>',
    '<script>function g(k){ return []["map"][k]; } g("constructor")</script>',
    '<script>for (const [k] of [["constructor"]]) { []["map"][k]; }</script>',
    '<script>const k = String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114); []["map"][k]</script>',
    '<script>class C extends (this, Array) {}</script>',
    '<script>class A { [this.open("https://evil.test")]() {} }</script>',
    '<script>navigation.navigate("https://evil.test");</script>',
    '<script>(setTimeout)("alert(1)", 0);</script>',
    '<script>(0, setTimeout)("alert(1)", 0);</script>',
    '<script>const [code] = ["alert(1)"]; setTimeout(code, 0);</script>',
    '<script>const st = setTimeout; st(function(){}, 0);</script>',
    // Iteration 8 AST bypass vectors (ObjectLiteralExpression destructuring, ||=/&&=/??=, Number/Math shadowing & mutation, mutable string TOCTOU)
    '<script>let F; ({ "constructor": F } = [].map); F("return 1")();</script>',
    '<script>let d; ({ ownerDocument: d } = document.body);</script>',
    '<script>let constructor; ({ constructor } = [].map);</script>',
    '<script>let ownerDocument; ({ ownerDocument } = document.body);</script>',
    '<script>let d; ([{ ownerDocument: d }] = [document.body]);</script>',
    '<script>let d; for ({ ownerDocument: d } of [document.body]) {}</script>',
    '<script>let d; const k = "owner" + "Document"; ({ [k]: d } = document.body);</script>',
    '<script>let d; let k = "x"; ({ [k]: d } = document.body);</script>',
    '<script>let k = 0; k ||= "constructor"; []["map"][k];</script>',
    '<script>let k = 1; k &&= "constructor"; []["map"][k];</script>',
    '<script>let k = 0; k ??= "constructor"; []["map"][k];</script>',
    '<script>let k = 0; (k) ||= "constructor"; []["map"][k];</script>',
    '<script>var Number = function(x){ return x; }; document.body[Number("ownerDocument")];</script>',
    '<script>function Number(x){ return x; } []["map"][Number("constructor")];</script>',
    '<script>{ var Number = function(x){ return x; }; } []["map"][Number("constructor")];</script>',
    '<script>Number = function(x){ return x; }; document.body[Number("ownerDocument")];</script>',
    '<script>Math.floor = function(x){ return x; }; document.body[Math.floor("ownerDocument")];</script>',
    '<script>var Math = { floor: function(x){ return x; } }; document.body[Math.floor("ownerDocument")];</script>',
    '<script>parseInt = function(x){ return x; }; []["map"][parseInt("constructor")];</script>',
    '<script>const m = Math; m.floor = function(x){ return x; }; []["map"][Math.floor("constructor")];</script>',
    '<script>Object.assign(Math, { floor: function(x){ return x; } }); []["map"][Math.floor("constructor")];</script>',
    '<script>delete Math.floor; []["map"][Math.floor("constructor")];</script>',
    '<script>let a = "a"; function init(){ return []["map"][a + "constructor"]; } a = ""; init();</script>',
    '<script>let a = "a"; for (let i = 0; i < 2; i++) { const F = []["map"][a + "constructor"]; a = ""; }</script>',
    '<script>let a = "con"; function getF(){ return []["map"][a]; } a += "structor"; getF();</script>',
    '<script>let k = 0; function f(){ let m = k; return []["map"][m]; } k = "constructor"; f();</script>',
  ]) {
    assert.throws(() => sanitizeSimulationHtml(unsafe), `expected unsafe HTML rejected: ${unsafe}`);
  }

  // Clean HTML with '>' inside quoted attribute or harmless data-* / SVG / JS patterns must still pass
  assert.doesNotThrow(() =>
    sanitizeSimulationHtml('<div class="sim-wrap" title="a > b" data-note="onclick=1"><a href="#sec">ok</a><img src="data:image/svg+xml;utf8,<svg/>"/></div>'),
  );
  assert.doesNotThrow(() =>
    sanitizeSimulationHtml(
      '<div class="sim-wrap"><svg viewBox="0 0 100 100"><animate attributeName="opacity" from="0" to="1" dur="1s"/><use href="#icon"/></svg><script>window.addEventListener("resize", function(){ var top = 10; var y = top; var half = (a + b) / 2; });</script></div>',
    ),
  );
  assert.doesNotThrow(() =>
    sanitizeSimulationHtml(
      '<div class="sim-wrap"><script>let top = 10; let y = top; var particle = { location: { x: 1, y: 2 } }; particle.location = { x: 3, y: 4 }; const key = "x"; const v = particle.location[key]; setTimeout(function(){ return v + y; }, 16);</script></div>',
    ),
  );
  assert.doesNotThrow(() =>
    sanitizeSimulationHtml(
      '<div class="sim-wrap" id="r"><script>var el = document.getElementById("r"); var d = document.createElement("div"); document.querySelectorAll("div"); var h = window.innerHeight; window.requestAnimationFrame(function(){ return (1 + 2) / 3; });</script></div>',
    ),
  );
  assert.doesNotThrow(() =>
    sanitizeSimulationHtml('<div class="sim-wrap"><p>CSS @import and fetch() and document.cookie explained in text</p></div>'),
  );
  assert.doesNotThrow(() =>
    sanitizeSimulationHtml(
      `<div class="sim-wrap"><canvas id="c"></canvas><script>// lead comment\n/* block */\nclass Particle { constructor(x, y) { this.x = x; this.y = y; this.location = { x, y }; } }\nvar label = "Click to fetch next step // Reflect on result";\nvar s = String(label).replace(/"/g, "&quot;");\nvar b = atob("AA//BB==");\n</script></div>`,
    ),
  );
  assert.doesNotThrow(() =>
    sanitizeSimulationHtml(
      `<div class="sim-wrap"><script>var arr = [10, 20, 30]; for (var i = 0; i < arr.length; i++) { var v = arr[i]; var next = arr[(i + 1) % arr.length]; } arr.forEach(function(item, rawIdx){ var idx = rawIdx | 0; var n = Number(rawIdx); arr[idx]; arr[Math.floor(n)]; }); var safeN = 0; safeN ||= 1; arr[safeN];</script></div>`,
    ),
  );

  // CJK and English page/section ordinal markers like "第 1 頁" / "Page 1" must not become bogus numeric parameters/quizzes
  const ordSignals = extractPassageSignals(undefined, "第 1 頁\nPage 1\nSection 2\nFrame budget is 16.6ms");
  assert.equal(ordSignals.numbers.length, 1);
  assert.equal(ordSignals.numbers[0].value, 16.6);
  assert.equal(ordSignals.numbers[0].unit, "ms");

  const ordOnlyStepper = buildDeterministicStepper({
    block: { id: "p-ord", kind: "paragraph", text: "第 1 頁" },
    pageTitle: "Page Header",
  });
  assert.ok(!ordOnlyStepper.checks[0].question.includes("「第」"));

  const enOrdSignals = extractPassageSignals(undefined, "Page 1 Scheduler quantum=20ms");
  assert.equal(enOrdSignals.numbers.length, 1);
  assert.equal(enOrdSignals.numbers[0].label, "quantum");
  assert.equal(enOrdSignals.numbers[0].value, 20);
  assert.equal(enOrdSignals.numbers[0].unit, "ms");

  const enOrdStepper = buildDeterministicStepper({
    block: { id: "p-en-ord", kind: "paragraph", text: "Page 1 Scheduler quantum=20ms" },
    pageTitle: "Scheduler Notes",
  });
  assert.ok(enOrdStepper.checks[0].question.includes("「quantum」"));
  assert.ok(!enOrdStepper.checks[0].question.includes("數值「Page」"));

  // Decimal numbers stay intact in sentence extraction; stop-words are not parameter labels; quote+block deduplicate by value+unit
  const budgetBlock = {
    id: "p-budget",
    kind: "paragraph" as const,
    text: "Frame budget is 16.6ms at 60Hz with 25ms max task latency",
  };
  const budgetSignals = extractPassageSignals(budgetBlock, "16.6ms at 60Hz");
  assert.deepEqual(budgetSignals.numbers, [
    { label: "參數 (ms)", value: 16.6, unit: "ms" },
    { label: "參數 (Hz)", value: 60, unit: "Hz" },
    { label: "參數 (ms)", value: 25, unit: "ms" },
  ]);
  assert.equal(budgetSignals.sentences[0], "16.6ms at 60Hz");
  assert.ok(!budgetSignals.sentences.some((s) => s.startsWith("6ms")));
  const budgetSim = buildDeterministicSimulation({ block: budgetBlock, quote: "16.6ms at 60Hz", pageTitle: "Frame Budget" });
  assert.ok(!budgetSim.summary.includes("at 60Hz") && !budgetSim.summary.includes("is 16.6ms"));
  assert.ok(decodeSimPayload(budgetSim.html).includes('"formula":"16.6ms at 60Hz"'));

  // Explicit technical parameters survive stop-word filtering while code-condition literals like if (1) / while (0) do not become sliders
  const techSignals = extractPassageSignals(
    undefined,
    "System latency=45ms, frame budget 16.6ms at 60Hz, max 25ms, burst 42ms, target 120 fps",
  );
  assert.deepEqual(
    techSignals.numbers.map((n) => [n.label, n.value, n.unit]),
    [
      ["latency", 45, "ms"],
      ["budget", 16.6, "ms"],
      ["參數 (Hz)", 60, "Hz"],
      ["參數 (ms)", 25, "ms"],
    ],
  );
  const fpsSignals = extractPassageSignals(undefined, "burst 42ms and target 120 fps");
  assert.deepEqual(fpsSignals.numbers, [
    { label: "burst", value: 42, unit: "ms" },
    { label: "target", value: 120, unit: "fps" },
  ]);
  const condOrdSignals = extractPassageSignals(
    undefined,
    'On Page 1 of Section 2 and Chapter 3, Part 4, Fig. 5, 第 1 頁 explains if (1) /"/; while (0) fetch -> document.cookie',
  );
  assert.deepEqual(condOrdSignals.numbers, []);
  const condOrdStepper = buildDeterministicStepper({
    block: { id: "p-cond-ord", kind: "paragraph", text: 'Page 1 Section 2 if (1) /"/; fetch -> document.cookie' },
    pageTitle: "Control Flow",
  });
  assert.ok(!condOrdStepper.checks[0].question.includes("關鍵數值"));

  // Zero-value numeric simulation + stepper edge case & SVG escaping
  const zeroSim = buildDeterministicSimulation({
    block: {
      id: "b-zero",
      kind: "paragraph",
      text: "在理想狀態下，錯誤率為 0%，阻塞延遲為 0ms。",
    },
    pageTitle: "Zero Value Edge",
  });
  assert.ok(decodeSimPayload(zeroSim.html).includes('"base":0,"min":0,'), "expected zero-value numeric slider min === 0");
  assert.doesNotThrow(() => sanitizeSimulationHtml(zeroSim.html));

  const zeroStepper = buildDeterministicStepper({
    block: {
      id: "b-zero-step",
      kind: "paragraph",
      text: "在理想狀態下，錯誤率為 0%。",
    },
    prompt: "x",
    pageTitle: "Zero Step",
  });
  assert.equal(new Set(zeroStepper.checks[0].options).size, zeroStepper.checks[0].options.length);
  assert.equal(zeroStepper.checks[0].correctIndex, "x".length % zeroStepper.checks[0].options.length);

  const angleTableSim = buildDeterministicSimulation({
    block: {
      id: "b-angle",
      kind: "table",
      text: "Node | Latency\n<T1> & A | 5ms\nT2 | 12ms",
      tableRows: [
        ["Node", "Latency"],
        ["<T1> & A", "5ms"],
        ["T2", "12ms"],
      ],
    },
    pageTitle: "Angle Table",
  });
  assert.ok(angleTableSim.html.includes("function esc("), "expected SVG escaping helper in table simulation");
  assert.ok(angleTableSim.html.includes("esc(entry.item.name.slice(0, 12))"));
  assert.doesNotThrow(() => sanitizeSimulationHtml(angleTableSim.html));

  // All 4 deterministic simulation templates pass sanitizer even when passage mentions fetch/localStorage/cookie/onclick
  const riskyWebText = "fetch('/api') localStorage document.cookie window.open() <button onclick=x> window['top']";
  for (const b of [
    { id: "r-tbl", kind: "table" as const, text: riskyWebText, tableRows: [["API", "Usage"], ["fetch()", riskyWebText]] },
    { id: "r-code", kind: "code" as const, text: `const a = await fetch('/api');\ndocument.cookie = 'x=1';\n${riskyWebText}` },
    { id: "r-num", kind: "paragraph" as const, text: `Timeout 30ms with ${riskyWebText}` },
    { id: "r-flow", kind: "paragraph" as const, text: `fetch('/api') -> localStorage -> document.cookie -> window.open()` },
  ]) {
    const s = buildDeterministicSimulation({ block: b, pageTitle: "Web APIs" });
    assert.doesNotThrow(() => sanitizeSimulationHtml(s.html), `template for ${b.id} must pass sanitizer`);
  }
});

test("M2 API: PDF upload/URL/serving, interactive blocks CRUD/CSP, annotation PATCH, refetch, and Suite Today", async () => {
  const tempDataDir = mkdtempSync(join(tmpdir(), "bell-reader-m2-test-"));
  const store = new ReaderStore(":memory:");
  let refetchVersion = 1;

  const app = createApp({
    store,
    dataDir: tempDataDir,
    sourceFetcher: async (url) => {
      if (url.endsWith(".pdf")) {
        return {
          kind: "pdf",
          bytes: makeMinimalPdf("BT /F1 12 Tf 72 720 Td (Remote PDF 128MB buffer) Tj ET"),
          finalUrl: new URL(url),
          contentType: "application/pdf",
        };
      }
      const text =
        refetchVersion === 1
          ? "First snapshot discusses 16.6ms frame budget and Microtask Queue."
          : "Updated snapshot v2 discusses 8.3ms 120Hz frame budget and Microtask Queue.";
      return {
        kind: "html",
        html: `<article><h1>Refetchable Article</h1><p>${text}</p></article>`,
        finalUrl: new URL(url),
        contentType: "text/html",
      };
    },
    aiRunner: async (prompt) => {
      if (prompt.includes("互動模擬")) {
        throw new AppError(503, "AI unconfigured in test");
      }
      return {
        title: "AI 深化：微任務排程",
        summary: "AI 整理後的步驟與自我檢核。",
        steps: [
          { label: "步驟 1 · 清空佇列", detail: "Microtask Queue 必須全數清空。", highlightToken: "Microtask" },
          { label: "步驟 2 · 繪製檢查", detail: "進入 rAF 與重繪。", highlightToken: "rAF" },
        ],
        checks: [
          {
            question: "哪個佇列會在 Macrotask 後立即清空？",
            options: ["Microtask Queue", "GPU Texture Pool"],
            correctIndex: 0,
            explanation: "JS 引擎在進入渲染前會先清空 Microtask Queue。",
          },
        ],
      };
    },
  });

  const srv = await listenLocal(app);
  try {
    // 1. Raw PDF upload + magic validation + same-origin framing headers + delete cleanup
    const badPdfRes = await fetch(`${srv.url}/api/pages/pdf`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-bell-filename": "bad.pdf" },
      body: new Uint8Array(Buffer.from("NOT A PDF")),
    });
    assert.equal(badPdfRes.status, 422);

    const oversizedRes = await fetch(`${srv.url}/api/pages/pdf`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-bell-filename": "huge.pdf" },
      body: new Uint8Array(15 * 1024 * 1024 + 64),
    });
    assert.equal(oversizedRes.status, 413);

    const nonJsonFolder = await fetch(`${srv.url}/api/folders`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: new Uint8Array(Buffer.from("%PDF-1.4")),
    });
    assert.equal(nonJsonFolder.status, 415);

    const samplePdf = makeMinimalPdf("BT /F1 12 Tf 72 720 Td (Uploaded PDF 42KB packet) Tj ET");
    const uploadRes = await fetch(`${srv.url}/api/pages/pdf`, {
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        "x-bell-filename": encodeURIComponent("網路封包講義.pdf"),
      },
      body: new Uint8Array(samplePdf),
    });
    assert.equal(uploadRes.status, 201);
    const uploadBody = (await uploadRes.json()) as { page: { id: string; sourceKind: string; hasPdf?: boolean; title: string } };
    assert.equal(uploadBody.page.sourceKind, "pdf");
    assert.equal(uploadBody.page.hasPdf, true);
    assert.equal(uploadBody.page.title, "網路封包講義");

    const pdfPathOnDisk = join(tempDataDir, "pdfs", `${uploadBody.page.id}.pdf`);
    assert.ok(existsSync(pdfPathOnDisk), "expected PDF file persisted in dataDir/pdfs");

    const servePdfRes = await fetch(`${srv.url}/api/pages/${uploadBody.page.id}/pdf`);
    assert.equal(servePdfRes.status, 200);
    assert.equal(servePdfRes.headers.get("content-type"), "application/pdf");
    assert.equal(servePdfRes.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.ok((servePdfRes.headers.get("content-security-policy") || "").includes("frame-ancestors 'self'"));
    const servedBytes = Buffer.from(await servePdfRes.arrayBuffer());
    assert.deepEqual(servedBytes, samplePdf);

    // Deleting page removes persisted PDF file
    const delPdfRes = await fetch(`${srv.url}/api/pages/${uploadBody.page.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
    assert.equal(delPdfRes.status, 200);
    assert.equal(existsSync(pdfPathOnDisk), false);

    // 2. Public HTTPS .pdf URL ingestion + SSRF protection
    const ssrfPdfRes = await fetch(`${srv.url}/api/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://127.0.0.1/secret.pdf" }),
    });
    assert.equal(ssrfPdfRes.status, 400);

    const urlPdfRes = await fetch(`${srv.url}/api/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/papers/buffer.pdf" }),
    });
    assert.equal(urlPdfRes.status, 201);
    const urlPdfBody = (await urlPdfRes.json()) as { page: { id: string; hasPdf?: boolean } };
    assert.equal(urlPdfBody.page.hasPdf, true);

    // 3. URL page + annotation PATCH + interactive blocks CRUD/fallback/CSP + refetch
    const pageRes = await fetch(`${srv.url}/api/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/articles/budget" }),
    });
    assert.equal(pageRes.status, 201);
    const { page } = (await pageRes.json()) as {
      page: { id: string; blocks: Array<{ id: string; text: string }> };
    };

    const annCreate = await fetch(`${srv.url}/api/pages/${page.id}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        blockId: page.blocks[0].id,
        quote: "Microtask Queue",
        style: "highlight",
        color: "amber",
        note: "初始筆記",
      }),
    });
    assert.equal(annCreate.status, 201);
    const { annotation } = (await annCreate.json()) as { annotation: { id: string } };

    const annPatch = await fetch(`${srv.url}/api/pages/${page.id}/annotations/${annotation.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "更新後的筆記內容", label: "核心機制" }),
    });
    assert.equal(annPatch.status, 200);
    const patchedAnn = (await annPatch.json()) as { annotation: { note: string; label?: string } };
    assert.equal(patchedAnn.annotation.note, "更新後的筆記內容");
    assert.equal(patchedAnn.annotation.label, "核心機制");

    const clearLabelPatch = await fetch(`${srv.url}/api/pages/${page.id}/annotations/${annotation.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "清除標籤後筆記", label: null }),
    });
    assert.equal(clearLabelPatch.status, 200);
    const clearedAnn = (await clearLabelPatch.json()) as { annotation: { note: string; label?: string | null } };
    assert.equal(clearedAnn.annotation.note, "清除標籤後筆記");
    assert.equal(clearedAnn.annotation.label, undefined);

    const restorePatch = await fetch(`${srv.url}/api/pages/${page.id}/annotations/${annotation.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "更新後的筆記內容", label: "核心機制" }),
    });
    assert.equal(restorePatch.status, 200);

    const missingAnnPatch = await fetch(`${srv.url}/api/pages/${page.id}/annotations/missing-id`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "should fail" }),
    });
    assert.equal(missingAnnPatch.status, 404);

    // Interactive simulation with mode=auto falls back seamlessly when AI throws 503
    const simCreate = await fetch(`${srv.url}/api/pages/${page.id}/interactive-blocks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        afterBlockId: page.blocks[0].id,
        quote: "16.6ms frame budget",
        kind: "simulation",
        mode: "auto",
      }),
    });
    assert.equal(simCreate.status, 201);
    const simBody = (await simCreate.json()) as { block: { id: string; source: string } };
    assert.equal(simBody.block.source, "deterministic");

    const frameRes = await fetch(`${srv.url}/api/pages/${page.id}/interactive-blocks/${simBody.block.id}/frame?theme=dark`);
    assert.equal(frameRes.status, 200);
    assert.match(frameRes.headers.get("content-type") || "", /text\/html/);
    assert.equal(frameRes.headers.get("x-frame-options"), "SAMEORIGIN");
    const frameCsp = frameRes.headers.get("content-security-policy") || "";
    assert.ok(frameCsp.includes("default-src 'none'"));
    const nonceMatch = frameCsp.match(/script-src 'nonce-([A-Za-z0-9_-]+)'/);
    assert.ok(nonceMatch, `expected script-src nonce in CSP: ${frameCsp}`);
    const scriptSrcDirective = frameCsp.match(/script-src[^;]+/)?.[0] || "";
    assert.ok(!scriptSrcDirective.includes("'unsafe-inline'"), "script-src must not permit unsafe-inline");
    assert.ok(frameCsp.includes("connect-src 'none'"));
    assert.ok(frameCsp.includes("frame-ancestors 'self'"));
    assert.ok(frameCsp.includes("sandbox allow-scripts"));
    const frameHtml = await frameRes.text();
    const scriptTags = frameHtml.match(/<script\b[^>]*>/gi) ?? [];
    assert.ok(scriptTags.length >= 2, "expected theme script and simulation script tags");
    for (const tag of scriptTags) {
      assert.ok(tag.includes(`nonce="${nonceMatch[1]}"`), `expected matching nonce on script tag: ${tag}`);
    }
    assert.ok(decodeSimPayload(frameHtml).includes("16.6"));

    // Interactive stepper + upgrade + state persistence + delete
    const stepCreate = await fetch(`${srv.url}/api/pages/${page.id}/interactive-blocks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        afterBlockId: page.blocks[0].id,
        kind: "stepper",
      }),
    });
    assert.equal(stepCreate.status, 201);
    const stepBody = (await stepCreate.json()) as { block: { id: string } };

    const statePatch = await fetch(`${srv.url}/api/pages/${page.id}/interactive-blocks/${stepBody.block.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: { activeStep: 1, answers: { "0": 0 } } }),
    });
    assert.equal(statePatch.status, 200);

    const upgradeRes = await fetch(`${srv.url}/api/pages/${page.id}/interactive-blocks/${stepBody.block.id}/upgrade`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(upgradeRes.status, 200);
    const upgraded = (await upgradeRes.json()) as { block: { source: string; title: string } };
    assert.equal(upgraded.block.source, "ai");
    assert.equal(upgraded.block.title, "AI 深化：微任務排程");

    // Refetch preserves id, interactiveBlocks, and re-anchors annotations
    refetchVersion = 2;
    const refetchRes = await fetch(`${srv.url}/api/pages/${page.id}/refetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(refetchRes.status, 200);
    const refetched = (await refetchRes.json()) as {
      page: {
        id: string;
        blocks: Array<{ text: string }>;
        annotations: Array<{ quote: string; note: string }>;
        interactiveBlocks: Array<{ id: string }>;
      };
    };
    assert.equal(refetched.page.id, page.id);
    assert.ok(refetched.page.blocks[0].text.includes("120Hz"));
    assert.equal(refetched.page.annotations[0].note, "更新後的筆記內容");
    assert.equal(refetched.page.interactiveBlocks.length, 2);

    // Delete interactive block leaves page blocks & annotations untouched
    const delIb = await fetch(`${srv.url}/api/pages/${page.id}/interactive-blocks/${simBody.block.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
    assert.equal(delIb.status, 200);
    const afterDel = (await delIb.json()) as { page: { blocks: unknown[]; annotations: unknown[]; interactiveBlocks: unknown[] } };
    assert.equal(afterDel.page.blocks.length, 1);
    assert.equal(afterDel.page.annotations.length, 1);
    assert.equal(afterDel.page.interactiveBlocks.length, 1);

    // JS/web passage mentioning fetch/localStorage/cookie/window.open/onclick works in deterministic simulation
    const jsPageRes = await fetch(`${srv.url}/api/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Web API Security Notes",
        content: "const res = await fetch('/api/items'); localStorage.setItem('k', 'v'); document.cookie; window.open(); <button onclick=x>",
      }),
    });
    assert.equal(jsPageRes.status, 201);
    const { page: jsPage } = (await jsPageRes.json()) as { page: { id: string; blocks: Array<{ id: string }> } };
    const jsSimCreate = await fetch(`${srv.url}/api/pages/${jsPage.id}/interactive-blocks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        afterBlockId: jsPage.blocks[0].id,
        quote: "const res = await fetch('/api/items'); localStorage.setItem('k', 'v'); document.cookie; window.open(); <button onclick=x>",
        kind: "simulation",
        mode: "instant",
      }),
    });
    assert.equal(jsSimCreate.status, 201);
    const jsSimBody = (await jsSimCreate.json()) as { block: { id: string } };
    const jsFrameRes = await fetch(`${srv.url}/api/pages/${jsPage.id}/interactive-blocks/${jsSimBody.block.id}/frame`);
    assert.equal(jsFrameRes.status, 200);
    const jsFrameHtml = await jsFrameRes.text();
    assert.ok(decodeSimPayload(jsFrameHtml).includes("fetch('/api/items')"));

    // Translate fails cleanly with 503 when AI is unconfigured without corrupting page state
    const prevApiKey = process.env.AI_API_KEY;
    delete process.env.AI_API_KEY;
    try {
      const noAiApp = createApp({ store, dataDir: tempDataDir });
      const noAiSrv = await listenLocal(noAiApp);
      try {
        await fetch(`${noAiSrv.url}/api/settings`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "api" }),
        });
        const offlineTrRes = await fetch(`${noAiSrv.url}/api/pages/${page.id}/translate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
        });
        assert.equal(offlineTrRes.status, 503);
        const offlineTrBody = (await offlineTrRes.json()) as { error?: string };
        assert.ok(offlineTrBody.error && offlineTrBody.error.includes("AI_API_KEY"));
        const intactPageRes = await fetch(`${noAiSrv.url}/api/pages/${page.id}`);
        assert.equal(intactPageRes.status, 200);
        const intactPage = (await intactPageRes.json()) as { id: string; translatedBlocks?: unknown };
        assert.equal(intactPage.id, page.id);
        assert.equal(intactPage.translatedBlocks, undefined);
      } finally {
        await noAiSrv.close();
      }
    } finally {
      if (prevApiKey !== undefined) process.env.AI_API_KEY = prevApiKey;
    }

    // 4. Suite Today strict schema check
    const todayRes = await fetch(`${srv.url}/api/suite/today`);
    assert.equal(todayRes.status, 200);
    const today = (await todayRes.json()) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(today).sort(),
      ["appId", "counts", "generatedAt", "items", "schemaVersion", "truncated"],
    );
    const items = today.items as Array<Record<string, unknown>>;
    for (const item of items) {
      assert.deepEqual(
        Object.keys(item).sort(),
        ["detail", "href", "id", "sourceApp", "state", "title", "type", "updatedAt"],
      );
      assert.ok([...String(item.detail)].length <= SUITE_LIMITS.detail);
    }
  } finally {
    await srv.close();
    store.close();
    rmSync(tempDataDir, { recursive: true, force: true });
  }
});

test("Extractor SSRF protection: trailing-dot local hostnames, pinned DNS lookup, mixed public/private rejection, redirect SSRF, and hop cap", async () => {
  // 0. Trailing-dot local / tailnet hostnames rejected before DNS or HTML embedding
  for (const localUrl of [
    "https://localhost./",
    "https://sub.localhost./",
    "https://printer.local./",
    "https://box.ts.net./",
    "https://./",
  ]) {
    assert.throws(
      () => validatePublicUrl(localUrl),
      (err: unknown) => err instanceof AppError && err.status === 400,
      `expected ${localUrl} to be rejected`,
    );
  }

  // 1. createPinnedLookup returns all matching entries when options.all === true, filters by family, errors if missing
  const pinned = createPinnedLookup([
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]);
  await new Promise<void>((resolve, reject) => {
    pinned("example.com", { all: true }, (err, list) => {
      if (err) return reject(err);
      assert.equal((list as Array<{ address: string }>).length, 2);
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    pinned("example.com", { family: 6 }, (err, addr, fam) => {
      if (err) return reject(err);
      assert.equal(addr, "2606:2800:220:1:248:1893:25c8:1946");
      assert.equal(fam, 6);
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    const ipv4Only = createPinnedLookup([{ address: "93.184.216.34", family: 4 }]);
    ipv4Only("example.com", { family: 6 }, (err) => {
      assert.ok(err instanceof Error);
      resolve();
    });
  });

  // 2. Mixed [public, 127.0.0.1] resolution rejected before fetch runs
  let fetchCalled = false;
  await assert.rejects(
    () =>
      fetchPublicPageSource("https://rebinding.example/article", new AbortController().signal, {
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
        fetch: (async () => {
          fetchCalled = true;
          return new UndiciResponse("ok");
        }) as typeof import("undici").fetch,
      }),
    (err: unknown) => err instanceof AppError && err.status === 400,
  );
  assert.equal(fetchCalled, false);

  // 3. Single lookup per hop with pinned Agent dispatcher (second DNS answer 127.0.0.1 is never queried)
  let lookupCalls = 0;
  let receivedDispatcher: unknown;
  const okSource = await fetchPublicPageSource("https://stable.example/page", new AbortController().signal, {
    lookup: async () => {
      lookupCalls += 1;
      if (lookupCalls === 1) return [{ address: "93.184.216.34", family: 4 }];
      return [{ address: "127.0.0.1", family: 4 }];
    },
    fetch: (async (_url, init) => {
      receivedDispatcher = init?.dispatcher;
      return new UndiciResponse("<html><body><p>Public page</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }) as typeof import("undici").fetch,
  });
  assert.equal(lookupCalls, 1);
  assert.ok(receivedDispatcher, "expected pinned Agent dispatcher passed to fetch");
  assert.equal(okSource.kind, "html");

  // 4. 302 redirect to loopback literal, http:// downgrade, or internal DNS target rejected before redirected fetch
  for (const badLocation of [
    "https://127.0.0.1/secret",
    "http://example.com/downgrade",
    "https://metadata.internal.example/latest",
  ]) {
    let hop = 0;
    await assert.rejects(
      () =>
        fetchPublicPageSource("https://redirector.example/start", new AbortController().signal, {
          lookup: async (host: string) => {
            if (host === "metadata.internal.example") return [{ address: "169.254.169.254", family: 4 }];
            return [{ address: "93.184.216.34", family: 4 }];
          },
          fetch: (async () => {
            hop += 1;
            if (hop > 1) throw new Error("redirected fetch must not run for unsafe target");
            return new UndiciResponse(null, { status: 302, headers: { location: badLocation } });
          }) as typeof import("undici").fetch,
        }),
      (err: unknown) => err instanceof AppError && err.status === 400,
    );
    assert.equal(hop, 1);
  }

  // 5. Redirect cap (>3 hops) rejected with 422
  await assert.rejects(
    () =>
      fetchPublicPageSource("https://loop.example/0", new AbortController().signal, {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        fetch: (async (u) => {
          const next = Number(String(u).split("/").pop() || "0") + 1;
          return new UndiciResponse(null, { status: 302, headers: { location: `https://loop.example/${next}` } });
        }) as typeof import("undici").fetch,
      }),
    (err: unknown) => err instanceof AppError && err.status === 422,
  );
});
