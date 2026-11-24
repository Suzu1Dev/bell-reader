import test from "node:test";
import assert from "node:assert/strict";
import {
  SUITE_LIMITS,
  allowedSuiteRoute,
  buildExplainHandoffText,
  explainDraftHref,
  parseReaderHandoff,
  prDraftHref,
} from "../../shared/suite.js";

test("SUITE_ROUTES.pr supports all 11 BELL PR routes and rejects unallowed paths", () => {
  for (const route of [
    "#/",
    "#/home",
    "#/demo",
    "#/repos",
    "#/repos/bell-reader",
    "#/discover",
    "#/team",
    "#/group",
    "#/learning",
    "#/settings",
    "#/runs/run_123",
  ]) {
    assert.equal(allowedSuiteRoute("pr", route), true, route);
  }
  for (const bad of ["#/runs/", "#/runs/..", "#/repos/a/b", "#/discover?draft=x", "#/unknown"]) {
    assert.equal(allowedSuiteRoute("pr", bad), false, bad);
  }
});

test("BELL PR two-way handoffs validate back routes and build #/discover draft links", () => {
  const links = { pr: "http://127.0.0.1:4603" };
  const incoming = parseReaderHandoff("#/read?text=Read+spec&title=Spec&from=pr&back=%23%2Fruns%2Frun_42", links);
  assert.equal(incoming.present, true);
  if (incoming.present && incoming.draft) {
    assert.equal(incoming.draft.from, "pr");
    assert.equal(incoming.draft.text, "Read spec");
    assert.equal(incoming.draft.title, "Spec");
    assert.equal(incoming.draft.backUrl, "http://127.0.0.1:4603/#/runs/run_42");
  }

  const outgoing = prDraftHref(links.pr, {
    draft: "Fix anchor calculation",
    title: "Ink anchor bug",
    back: "#/page/page_7",
  });
  assert.ok(outgoing?.startsWith("http://127.0.0.1:4603/#/discover?"));
  const params = new URLSearchParams(outgoing!.split("?")[1]);
  assert.equal(params.get("draft"), "Fix anchor calculation");
  assert.equal(params.get("title"), "Ink anchor bug");
  assert.equal(params.get("from"), "reader");
  assert.equal(params.get("back"), "#/page/page_7");
  assert.equal(prDraftHref(undefined, { draft: "x" }), undefined);
});

test("buildExplainHandoffText and explainDraftHref preserve structured context within bounds", () => {
  const pdfText = buildExplainHandoffText({
    sourceKind: "pdf",
    hasPdf: true,
    pdfPageCount: 12,
    title: "Attention Is All You Need",
    excerpt: "The dominant sequence transduction models are based on complex recurrent neural networks.",
    topic: "深度學習",
    blocks: [
      { kind: "heading", text: "第 1 頁" },
      { kind: "paragraph", text: "Self-attention relates different positions of a single sequence." },
    ],
    annotations: [{ quote: "Self-attention", note: "不需循環即可平行計算注意力權重" }],
    interactiveBlocks: [{ kind: "simulation", title: "注意力權重矩陣", summary: "調整溫度觀察 softmax 分布" }],
  });
  assert.ok(pdfText.includes("PDF 文件（12 頁）"));
  assert.ok(pdfText.includes("主題：深度學習"));
  assert.ok(pdfText.includes("Self-attention relates different positions"));
  assert.ok(pdfText.includes("重點標註"));
  assert.ok(pdfText.includes("互動模擬"));
  assert.ok([...pdfText].length <= SUITE_LIMITS.handoffText);

  const longHref = explainDraftHref("http://127.0.0.1:20001", {
    title: "T".repeat(200),
    text: "中".repeat(2500),
    back: "#/page/p_1",
    source: "pdf",
    url: "javascript:alert(1)",
    pdf: "Paper.pdf",
  });
  assert.ok(longHref?.startsWith("http://127.0.0.1:20001/#/explain?"));
  const longParams = new URLSearchParams(longHref!.split("?")[1]);
  assert.equal([...longParams.get("text")!].length, SUITE_LIMITS.handoffText);
  assert.equal([...longParams.get("title")!].length, SUITE_LIMITS.handoffTitle);
  assert.equal(longParams.get("source"), "pdf");
  assert.equal(longParams.get("pdf"), "Paper.pdf");
  assert.equal(longParams.get("url"), null);
  assert.equal(longParams.get("back"), "#/page/p_1");

  const urlHref = explainDraftHref("http://127.0.0.1:20001", {
    text: "Article body",
    url: "https://example.com/post",
    source: "url",
  });
  const urlParams = new URLSearchParams(urlHref!.split("?")[1]);
  assert.equal(urlParams.get("url"), "https://example.com/post");
  assert.equal(urlParams.get("source"), "url");
});

test("buildExplainHandoffText handles UTF-16 surrogate boundary at 359 and long first block after excerpt", () => {
  const emojiBlock = "A".repeat(359) + "😀" + "B".repeat(100);
  const emojiOut = buildExplainHandoffText({
    sourceKind: "paste",
    title: "Emoji Boundary",
    excerpt: "",
    topic: "未分類",
    blocks: [{ kind: "paragraph", text: emojiBlock }],
    annotations: [],
  });
  assert.ok(emojiOut.includes("😀"), "expected emoji preserved across 360-codepoint slice");
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emojiOut), false);

  const emojiHref = explainDraftHref("http://127.0.0.1:20001", {
    title: "Emoji Boundary",
    text: emojiOut,
    back: "#/page/p_emoji",
  });
  const decodedEmojiText = new URLSearchParams(emojiHref!.split("?")[1]).get("text")!;
  assert.ok(decodedEmojiText.includes("😀"));
  assert.equal(decodedEmojiText.includes("\uFFFD"), false);

  const longParagraphOut = buildExplainHandoffText({
    sourceKind: "url",
    title: "Long Paragraph Budget",
    excerpt: "E".repeat(160),
    topic: "未分類",
    blocks: [{ kind: "paragraph", text: "Different long paragraph " + "x".repeat(600) }],
    annotations: [],
  });
  assert.ok(longParagraphOut.includes("Different long paragraph"));
});
