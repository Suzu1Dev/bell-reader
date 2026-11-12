import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.js";
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
    aiRunner: async () => ({
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
    }),
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
  } finally {
    await srv.close();
    store.close();
    await new Promise<void>((done) => explainServer.close(() => done()));
  }
});
