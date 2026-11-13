import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.js";
import { annotatePageWithAI } from "./ai.js";
import {
  extractBlocksFromHtml,
  parsePastedContent,
  resolveQuoteAnchor,
  validatePublicUrl,
} from "./extractor.js";
import { ReaderStore } from "./store.js";

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

test("SSRF URL validation blocks private/loopback/non-https addresses", () => {
  assert.equal(validatePublicUrl("https://example.com/post?a=1#frag").href, "https://example.com/post?a=1");
  for (const bad of [
    "http://example.com/post",
    "https://127.0.0.1/secret",
    "https://192.168.1.10/admin",
    "https://[::1]/test",
    "https://localhost/test",
    "https://host.tailnet.ts.net/api",
    "https://user:pass@example.com/",
  ]) {
    assert.throws(() => validatePublicUrl(bad), `expected ${bad} to be rejected`);
  }
});

test("HTML extractor & quote anchor resolver preserve clean blocks and exact offsets", () => {
  const html = `
    <html>
      <head><title>Ignored — Site</title><meta property="og:title" content="深入理解 Event Loop" /></head>
      <body>
        <nav>導覽列雜訊</nav>
        <article>
          <h1>深入理解 Event Loop</h1>
          <h2>微任務佇列</h2>
          <p>當 Call Stack 清空時，引擎會優先執行所有 Microtask，之後才進行畫面重繪。</p>
          <pre><code class="language-ts">queueMicrotask(() => console.log("tick"));</code></pre>
        </article>
        <script>alert(1)</script>
      </body>
    </html>
  `;
  const extracted = extractBlocksFromHtml(html, new URL("https://blog.example.com/event-loop"));
  assert.equal(extracted.title, "深入理解 Event Loop");
  assert.equal(extracted.blocks.length, 3);
  assert.equal(extracted.blocks[0].kind, "heading");
  assert.equal(extracted.blocks[1].kind, "paragraph");
  assert.equal(extracted.blocks[2].kind, "code");

  const anchor = resolveQuoteAnchor(extracted.blocks[1].text, "優先執行所有 Microtask");
  assert.ok(anchor);
  assert.equal(
    extracted.blocks[1].text.slice(anchor.startOffset, anchor.endOffset),
    "優先執行所有 Microtask",
  );

  const pasted = parsePastedContent("# 測試筆記\n\n第一段文字內容。\n\n- 重點項目一");
  assert.equal(pasted.title, "測試筆記");
  assert.equal(pasted.blocks.length, 2);

  // Raw Markdown embedded inside #publish-page (e.g. HackMD SSR) splits cleanly into blocks
  const hackmdHtml = `
    <html>
      <head><title>SDF 入門 - HackMD</title><meta property="og:site_name" content="HackMD" /></head>
      <body>
        <div id="publish-page"># SDF 入門

透過**最近距離**描述幾何邊界。

- d = 0 : 表面
![示意圖](https://example.com/sdf.webp)

\`\`\`glsl
float sdBox(vec2 p) { return length(p); }
\`\`\`
</div>
      </body>
    </html>
  `;
  const mdPage = extractBlocksFromHtml(hackmdHtml, new URL("https://hackmd.io/@demo/sdf"));
  assert.equal(mdPage.title, "SDF 入門");
  assert.equal(mdPage.siteName, "HackMD");
  assert.deepEqual(
    mdPage.blocks.map((b) => b.kind),
    ["paragraph", "list", "image", "code"],
  );

  // Markdown tables & HTML tables both parse as structured "table" blocks
  const mdWithTable = parsePastedContent(
    "# 指令集對照\n\n說明文字。\n\n| 指令 | 用途 | 範例 |\n| :--- | --- | ---: |\n| `add` | 暫存器相加 | `add rd, rs1, rs2` |\n| `lw` | 載入位元組 | `lw rd, 0(rs1)` |",
  );
  const mdTableBlock = mdWithTable.blocks.find((b) => b.kind === "table");
  assert.ok(mdTableBlock);
  assert.equal(mdTableBlock.tableRows?.length, 3);
  assert.deepEqual(mdTableBlock.tableRows?.[0], ["指令", "用途", "範例"]);
  assert.deepEqual(mdTableBlock.tableRows?.[1], ["add", "暫存器相加", "add rd, rs1, rs2"]);

  const htmlWithTable = extractBlocksFromHtml(
    `<article><h1>CSR 表格</h1><table><thead><tr><th>名稱</th><th>位址</th></tr></thead><tbody><tr><td>mcycle</td><td>0xB00</td></tr></tbody></table></article>`,
    new URL("https://example.com/csr-table"),
  );
  const htmlTableBlock = htmlWithTable.blocks.find((b) => b.kind === "table");
  assert.ok(htmlTableBlock);
  assert.deepEqual(htmlTableBlock.tableRows, [
    ["名稱", "位址"],
    ["mcycle", "0xB00"],
  ]);
  assert.equal(mdPage.blocks[0].text, "透過最近距離描述幾何邊界。");
});

test("End-to-end API: URL dedup, AI doodle markup, auto-folder, manual note retention, and Explain topic bridge", async () => {
  // Mock BELL Explain server on 127.0.0.1
  const explainServer = http.createServer((req, res) => {
    if (req.url === "/api/lessons") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify([
          {
            id: "note-event-loop-1",
            title: "JavaScript Event Loop 排程模型",
            category: "前端工程",
            tags: ["Event Loop", "Microtask"],
          },
        ]),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => explainServer.listen(0, "127.0.0.1", () => resolve()));
  const explainPort = (explainServer.address() as AddressInfo).port;

  const store = new ReaderStore(":memory:");
  let fetchCalls = 0;
  let lastDensity: string | undefined;
  const app = createApp({
    store,
    suiteLinks: {
      explain: `http://127.0.0.1:${explainPort}`,
      personal: "http://127.0.0.1:21103",
    },
    suiteFetch: {
      explain: `http://127.0.0.1:${explainPort}`,
    },
    htmlFetcher: async (url) => {
      fetchCalls++;
      return {
        html: `<article><h1>Event Loop 實戰</h1><p>每個宏任務結束後都會先清空 Microtask Queue 再交還給渲染管線。</p></article>`,
        finalUrl: new URL(url),
        contentType: "text/html",
      };
    },
    aiRunner: async (input, runnerSettings, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(signal?.aborted, false, "request body completion must not abort AI runner");
      lastDensity = runnerSettings.annotationDensity;
      if (input.includes('"translations"')) {
        const marker = "輸入資料：\n";
        const idx = input.indexOf(marker);
        const payload = idx >= 0 ? JSON.parse(input.slice(idx + marker.length)) : {};
        const firstAnn = payload.annotations?.[0] as { id: string } | undefined;
        return {
          title: "RISC-V 指令集模擬器實戰",
          translations: [
            { id: "b1", text: "記憶體子系統（Memory Subsystem）負責載入 ELF 映像檔。" },
          ],
          ...(firstAnn ? { quotes: [{ id: firstAnn.id, quote: "記憶體子系統（Memory Subsystem）" }] } : {}),
        };
      }
      return {
        topic: "Event Loop",
        tags: ["Microtask", "瀏覽器渲染"],
        summary: "釐清宏任務、微任務與畫面重繪之間的排程順序。",
        suggestedFolder: "前端效能",
        annotations: [
          {
            blockId: "b1",
            quote: "先清空 Microtask Queue",
            style: "highlight",
            color: "amber",
            label: "核心規則",
            note: "微任務若無限遞迴，瀏覽器就無法進入下一幀繪製。",
            topic: "Microtask",
          },
        ],
      };
    },
  });

  const srv = await listenLocal(app);
  try {
    // 1. Security guards: cross-site API blocked & non-JSON POST rejected
    const crossSite = await fetch(`${srv.url}/api/pages`, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    assert.equal(crossSite.status, 403);

    const badContentType = await fetch(`${srv.url}/api/folders`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "name=test",
    });
    assert.equal(badContentType.status, 415);

    // 2. Save URL page & verify deduplication on second call
    const create1 = await fetch(`${srv.url}/api/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/articles/event-loop" }),
    });
    assert.equal(create1.status, 201);
    const body1 = (await create1.json()) as { page: { id: string }; reused: boolean };
    assert.equal(body1.reused, false);
    assert.equal(fetchCalls, 1);

    const create2 = await fetch(`${srv.url}/api/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/articles/event-loop" }),
    });
    assert.equal(create2.status, 200);
    const body2 = (await create2.json()) as { page: { id: string }; reused: boolean };
    assert.equal(body2.reused, true);
    assert.equal(body2.page.id, body1.page.id);
    assert.equal(fetchCalls, 1);

    // 3. Add manual user handwritten note
    const manualRes = await fetch(`${srv.url}/api/pages/${body1.page.id}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        blockId: "b1",
        quote: "渲染管線",
        style: "box",
        color: "sky",
        note: "自己的手寫眉批",
      }),
    });
    assert.equal(manualRes.status, 201);

    // 4. Run AI doodle annotation -> auto-classifies topic, creates folder, preserves manual note, matches Explain
    const annRes = await fetch(`${srv.url}/api/pages/${body1.page.id}/annotate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(annRes.status, 200);
    const annBody = (await annRes.json()) as {
      page: {
        topic: string;
        folderId: string | null;
        annotations: Array<{ source: string; quote: string }>;
      };
      folders: Array<{ id: string; name: string }>;
      explain: { status: string; matches: Array<{ id: string; href: string }> };
    };
    assert.equal(annBody.page.topic, "Event Loop");
    assert.equal(annBody.folders.length, 1);
    assert.equal(annBody.folders[0].name, "前端效能");
    assert.equal(annBody.page.folderId, annBody.folders[0].id);
    assert.equal(annBody.page.annotations.length, 2); // 1 user + 1 AI
    assert.equal(annBody.explain.status, "ready");
    assert.equal(annBody.explain.matches[0].id, "note-event-loop-1");
    assert.equal(annBody.explain.matches[0].href, "#/note/note-event-loop-1");

    // 4b. NDJSON streaming mode emits stage events + complete payload without premature abort
    const streamRes = await fetch(`${srv.url}/api/pages/${body1.page.id}/annotate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson",
      },
      body: JSON.stringify({}),
    });
    assert.equal(streamRes.status, 200);
    const lines = (await streamRes.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string });
    assert.ok(lines.some((l) => l.type === "stage"));
    assert.equal(lines[lines.length - 1]?.type, "complete");

    // 5. Suite manifest & today feed conform to Suite contract
    const manifestRes = await fetch(`${srv.url}/api/suite/manifest`);
    const manifest = (await manifestRes.json()) as { appId: string; schemaVersion: number };
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.appId, "reader");

    const todayRes = await fetch(`${srv.url}/api/suite/today`);
    const today = (await todayRes.json()) as { counts: { saved: number; annotated: number }; items: Array<{ href: string }> };
    assert.equal(today.counts.saved, 1);
    assert.equal(today.counts.annotated, 1);
    assert.equal(today.items[0].href, `#/page/${body1.page.id}`);

    // 6. Image block annotation stores normalized coordinates on a figure
    const imgPageRes = await fetch(`${srv.url}/api/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "圖表實驗頁",
        content: "實驗結果圖表：\n\n![Benchmark Graph](https://example.com/chart.png)",
      }),
    });
    assert.equal(imgPageRes.status, 201);
    const imgPageBody = (await imgPageRes.json()) as {
      page: { id: string; blocks: Array<{ id: string; kind: string }> };
    };
    const imgBlock = imgPageBody.page.blocks.find((b) => b.kind === "image");
    assert.ok(imgBlock);
    const imgAnnRes = await fetch(`${srv.url}/api/pages/${imgPageBody.page.id}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        blockId: imgBlock.id,
        quote: "Benchmark Graph",
        style: "box",
        color: "coral",
        label: "指令峰值",
        note: "注意右側延遲突然拉高",
        anchorX: 0.72,
        anchorY: 0.34,
      }),
    });
    assert.equal(imgAnnRes.status, 201);
    const imgAnnBody = (await imgAnnRes.json()) as {
      annotation: { anchorX?: number; anchorY?: number; label?: string };
    };
    assert.equal(imgAnnBody.annotation.anchorX, 0.72);
    assert.equal(imgAnnBody.annotation.anchorY, 0.34);
    assert.equal(imgAnnBody.annotation.label, "指令峰值");

    // 7. AI automatic annotation can target image blocks with anchor coordinates and persist across replaceAiAnnotations
    const mockAiImg = await annotatePageWithAI(
      imgPageBody.page as never,
      [],
      { provider: "codex", model: "", autoFolder: false },
      new AbortController().signal,
      async () => ({
        topic: "效能分析",
        tags: ["Benchmark"],
        summary: "測試 AI 針對圖表的自動座標標註。",
        suggestedFolder: "效能監測",
        annotations: [
          {
            blockId: imgBlock.id,
            quote: "P99 延遲突波",
            style: "box",
            color: "amber",
            label: "圖表關鍵",
            note: "右側突波顯示 GC 停頓造成尾部延遲拉高。",
            topic: "尾端延遲",
            anchorX: 0.81,
            anchorY: 0.27,
          },
        ],
      }),
      async () => ({
        bytes: Buffer.from("iVBORw0KGgo=", "base64"),
        mimeType: "image/png",
        ext: "png",
      }),
    );
    const aiImgAnn = mockAiImg.annotations.find((a) => a.blockId === imgBlock.id);
    assert.ok(aiImgAnn);
    assert.equal(aiImgAnn.anchorX, 0.81);
    assert.equal(aiImgAnn.anchorY, 0.27);
    const persistedPage = store.replaceAiAnnotations(imgPageBody.page.id, {
      topic: mockAiImg.topic,
      tags: mockAiImg.tags,
      summary: mockAiImg.summary,
      annotations: mockAiImg.annotations,
    });
    const savedAiImg = persistedPage.annotations.find((a) => a.source === "ai" && a.blockId === imgBlock.id);
    assert.ok(savedAiImg);
    assert.equal(savedAiImg.anchorX, 0.81);
    assert.equal(savedAiImg.anchorY, 0.27);

    // 8. Provider settings accept "antigravity" cleanly
    const agyPatchRes = await fetch(`${srv.url}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "antigravity", model: "gemini-3.8-flash-medium" }),
    });
    assert.equal(agyPatchRes.status, 200);
    const agySettings = (await agyPatchRes.json()) as { provider: string; model: string };
    assert.equal(agySettings.provider, "antigravity");
    assert.equal(agySettings.model, "gemini-3.8-flash-medium");

    // 9. Long articles (>70 blocks) chunk across multiple passes so latter sections receive annotations
    const longBlocks = Array.from({ length: 82 }, (_, i) => ({
      id: `b${i + 1}`,
      kind: "paragraph" as const,
      text: `Section ${i + 1}: RISC-V CSR instruction pipeline execution detail number ${i + 1}.`,
    }));
    let chunkCalls = 0;
    const longResult = await annotatePageWithAI(
      {
        ...(imgPageBody.page as object),
        id: "long-page-test",
        title: "Long RISC-V Walkthrough",
        blocks: longBlocks,
      } as never,
      [],
      { provider: "codex", model: "", autoFolder: false },
      new AbortController().signal,
      async (prompt) => {
        chunkCalls++;
        const marker = "輸入資料：\n";
        const payload = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
        const lastBlock = payload.blocks[payload.blocks.length - 1] as { id: string; text: string };
        const baseAnn = {
          blockId: lastBlock.id,
          quote: lastBlock.text.slice(0, 32),
          style: "highlight" as const,
          color: "violet" as const,
          label: "段落重點",
          note: `來自區段 ${payload.section} 的核心解釋與注意事項。`,
          topic: "RISC-V",
        };
        if (chunkCalls === 1 && payload.section.startsWith("1/")) {
          return {
            topic: "RISC-V",
            tags: ["Emulator", "RISC-V"],
            summary: "涵蓋開頭、中段與結尾的完整導讀筆記。",
            suggestedFolder: "系統架構",
            annotations: [baseAnn],
          };
        }
        return { annotations: [baseAnn] };
      },
    );
    assert.ok(chunkCalls >= 2, `expected multi-chunk calls, got ${chunkCalls}`);
    assert.ok(
      longResult.annotations.some((a) => Number(a.blockId.slice(1)) >= 70),
      "expected annotations in the latter half of long article (>= b70)",
    );

    // 10. Whole-page translation endpoint translates prose while preserving code blocks byte-for-byte
    const codeText = "uint32_t csr_read(uint32_t addr) { return mcycle; }";
    const enPageRes = await fetch(`${srv.url}/api/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "RISC-V Lab",
        content: `# RISC-V Lab\n\nMemory subsystem loads ELF images.\n\n\`\`\`c\n${codeText}\n\`\`\``,
      }),
    });
    assert.equal(enPageRes.status, 201);
    const enPageBody = (await enPageRes.json()) as { page: { id: string } };
    const preTrAnnRes = await fetch(`${srv.url}/api/pages/${enPageBody.page.id}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        blockId: "b1",
        quote: "Memory subsystem",
        style: "highlight",
        color: "amber",
        label: "核心概念",
        note: "ELF 映像檔由此載入記憶體。",
      }),
    });
    assert.equal(preTrAnnRes.status, 201);
    const trRes = await fetch(`${srv.url}/api/pages/${enPageBody.page.id}/translate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(trRes.status, 200);
    const trBody = (await trRes.json()) as {
      page: {
        translatedTitle?: string;
        translatedAt?: string;
        translatedBlocks?: Array<{ kind: string; text: string }>;
        annotations: Array<{ translatedQuote?: string }>;
      };
    };
    assert.equal(trBody.page.translatedTitle, "RISC-V 指令集模擬器實戰");
    assert.ok(trBody.page.translatedAt);
    assert.ok(trBody.page.translatedBlocks?.[0].text.includes("記憶體子系統"));
    assert.equal(trBody.page.annotations[0]?.translatedQuote, "記憶體子系統（Memory Subsystem）");
    const translatedCode = trBody.page.translatedBlocks?.find((b) => b.kind === "code");
    assert.equal(translatedCode?.text, codeText);

    // 11. Annotation density persists in settings and flows through POST /annotate
    const densityPatch = await fetch(`${srv.url}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ annotationDensity: "thorough" }),
    });
    assert.equal(densityPatch.status, 200);
    const densityBody = (await densityPatch.json()) as { annotationDensity?: string };
    assert.equal(densityBody.annotationDensity, "thorough");

    const sparseAnnRes = await fetch(`${srv.url}/api/pages/${body1.page.id}/annotate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ density: "sparse" }),
    });
    assert.equal(sparseAnnRes.status, 200);
    assert.equal(lastDensity, "sparse");
  } finally {
    await srv.close();
    store.close();
    await new Promise<void>((done) => explainServer.close(() => done()));
  }
});
