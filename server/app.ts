import express, { type NextFunction, type Request, type Response } from "express";
import compression from "compression";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  AI_PROVIDERS,
  ANNOTATION_DENSITIES,
  INK_COLORS,
  INK_STYLES,
  SKETCH_CURVE_SHAPES,
  SKETCH_KINDS,
} from "../shared/types.js";
import {
  SUITE_LIMITS,
  SUITE_OBJECT_ID,
  SUITE_UNSAFE_TEXT,
  type SuiteLinks,
  type SuiteManifest,
  type SuiteTodayFeed,
  type SuiteTodayItem,
} from "../shared/suite.js";
import {
  annotatePageWithAI,
  annotateSelectionWithAI,
  translatePageWithAI,
  type JsonPromptRunner,
} from "./ai.js";
import { AppError, publicError } from "./errors.js";
import { ExplainBridge } from "./explain-bridge.js";
import {
  extractBlocksFromHtml,
  fetchPublicHtml,
  parsePastedContent,
  resolveQuoteAnchor,
  validatePublicUrl,
} from "./extractor.js";
import { securityMiddleware } from "./security.js";
import type { ReaderStore } from "./store.js";

export interface CreateAppOptions {
  store: ReaderStore;
  allowedOrigins?: string[];
  suiteLinks?: SuiteLinks;
  suiteFetch?: Partial<Record<"explain" | "pr", string>>;
  aiRunner?: JsonPromptRunner;
  htmlFetcher?: typeof fetchPublicHtml;
  distDir?: string;
}

const createFolderSchema = z
  .object({
    name: z.string().trim().min(1).max(48),
    color: z.enum(INK_COLORS).optional(),
  })
  .strict();

const createPageSchema = z
  .object({
    url: z.string().trim().max(4000).optional(),
    content: z.string().max(120_000).optional(),
    title: z.string().trim().max(120).optional(),
    folderId: z.string().trim().nullable().optional(),
    forceRefetch: z.boolean().optional(),
  })
  .strict();

const updatePageSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    folderId: z.string().trim().nullable().optional(),
    topic: z.string().trim().min(1).max(40).optional(),
    tags: z.array(z.string().trim().min(1).max(24)).max(6).optional(),
  })
  .strict();

const sketchElementSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("rect"),
      x: z.number().min(0).max(360),
      y: z.number().min(0).max(220),
      w: z.number().min(8).max(360),
      h: z.number().min(8).max(220),
      fill: z.boolean().optional(),
      dashed: z.boolean().optional(),
      label: z.string().trim().max(32).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("ellipse"),
      x: z.number().min(0).max(360),
      y: z.number().min(0).max(220),
      rx: z.number().min(6).max(180),
      ry: z.number().min(6).max(110),
      fill: z.boolean().optional(),
      dashed: z.boolean().optional(),
      label: z.string().trim().max(32).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("arrow"),
      x1: z.number().min(0).max(360),
      y1: z.number().min(0).max(220),
      x2: z.number().min(0).max(360),
      y2: z.number().min(0).max(220),
      bend: z.number().min(-120).max(120).optional(),
      dashed: z.boolean().optional(),
      label: z.string().trim().max(28).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("line"),
      x1: z.number().min(0).max(360),
      y1: z.number().min(0).max(220),
      x2: z.number().min(0).max(360),
      y2: z.number().min(0).max(220),
      dashed: z.boolean().optional(),
      label: z.string().trim().max(28).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("curve"),
      points: z.array(z.tuple([z.number().min(0).max(360), z.number().min(0).max(220)])).min(2).max(12),
      fill: z.boolean().optional(),
      dashed: z.boolean().optional(),
      closed: z.boolean().optional(),
      label: z.string().trim().max(28).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("dot"),
      x: z.number().min(0).max(360),
      y: z.number().min(0).max(220),
      label: z.string().trim().max(28).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("text"),
      x: z.number().min(0).max(360),
      y: z.number().min(0).max(220),
      text: z.string().trim().min(1).max(36),
      size: z.enum(["sm", "md", "lg"]).optional(),
      align: z.enum(["start", "middle", "end"]).optional(),
    })
    .strict(),
]);

const manualAnnotationSchema = z
  .object({
    blockId: z.string().trim().min(1),
    quote: z.string().trim().min(1).max(300),
    style: z.enum(INK_STYLES),
    color: z.enum(INK_COLORS),
    label: z.string().trim().max(16).optional(),
    note: z.string().trim().min(1).max(320),
    topic: z.string().trim().max(28).optional(),
    anchorX: z.number().min(0).max(1).optional(),
    anchorY: z.number().min(0).max(1).optional(),
    sketch: z
      .object({
        kind: z.enum(SKETCH_KINDS),
        caption: z.string().trim().max(48).optional(),
        nodes: z.array(z.string().trim().min(1).max(24)).max(5),
        shape: z.enum(SKETCH_CURVE_SHAPES).optional(),
        elements: z.array(sketchElementSchema).max(24).optional(),
      })
      .strict()
      .refine(
        (s) => (s.kind === "canvas" ? (s.elements?.length ?? 0) >= 2 : s.nodes.length >= 2),
        "手繪圖解至少需要兩個元素或節點。",
      )
      .optional(),
  })
  .strict();

const aiSelectionSchema = z
  .object({
    blockId: z.string().trim().min(1),
    quote: z.string().trim().min(2).max(240),
    style: z.enum(INK_STYLES).optional(),
    color: z.enum(INK_COLORS).optional(),
  })
  .strict();

const settingsPatchSchema = z
  .object({
    provider: z.enum(AI_PROVIDERS).optional(),
    model: z.string().max(160).optional(),
    autoFolder: z.boolean().optional(),
    annotationDensity: z.enum(ANNOTATION_DENSITIES).optional(),
  })
  .strict();

const annotateRequestSchema = z
  .object({
    density: z.enum(ANNOTATION_DENSITIES).optional(),
  })
  .strict()
  .optional();

export function createApp(options: CreateAppOptions) {
  const {
    store,
    allowedOrigins = [],
    suiteLinks = {},
    suiteFetch = {},
    aiRunner,
    htmlFetcher = fetchPublicHtml,
    distDir = resolve(process.cwd(), "dist"),
  } = options;

  const explainBridge = new ExplainBridge(suiteFetch.explain, suiteLinks.explain);
  const app = express();
  app.disable("x-powered-by");
  app.use(compression());
  app.use(securityMiddleware(allowedOrigins));
  app.use(express.json({ limit: "256kb" }));

  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // ── Suite Contract Endpoints ─────────────────────────────────────────────
  app.get("/api/suite/manifest", (_req, res) => {
    const manifest: SuiteManifest = {
      schemaVersion: 1,
      appId: "reader",
      displayName: "BELL Web Reader",
      summary: "網頁閱讀與標註",
      capabilities: [
        {
          id: "reader.draft",
          kind: "accept-handoff",
          route: "#/read",
          accepts: ["text"],
          maxChars: SUITE_LIMITS.handoffText,
        },
        {
          id: "reader.today",
          kind: "today-feed",
          api: "/api/suite/today",
        },
        {
          id: "reader.page",
          kind: "object-route",
          route: "#/page/{id}",
        },
      ],
      links: suiteLinks,
    };
    res.json(manifest);
  });

  app.get("/api/suite/today", (_req, res) => {
    const all = store.listPages().filter(
      (p) =>
        SUITE_OBJECT_ID.test(p.id) &&
        p.id !== "." &&
        p.id !== ".." &&
        p.title.trim().length > 0 &&
        !SUITE_UNSAFE_TEXT.test(p.title),
    );
    const annotatedCount = all.filter((p) => p.annotationCount > 0).length;
    const unannotatedCount = all.length - annotatedCount;
    const items: SuiteTodayItem[] = all.slice(0, SUITE_LIMITS.items).map((p) => {
      const detailText =
        p.topic && p.topic !== "未分類" && !SUITE_UNSAFE_TEXT.test(p.topic)
          ? `${p.topic} · ${p.annotationCount} 則標註`.slice(0, SUITE_LIMITS.detail)
          : `${p.annotationCount} 則標註`;
      return {
        sourceApp: "reader",
        type: "page",
        id: p.id,
        title: [...p.title].slice(0, SUITE_LIMITS.title).join(""),
        href: `#/page/${p.id}`,
        state: p.annotationCount > 0 ? "new" : "waiting",
        updatedAt: p.updatedAt,
        detail: detailText,
      };
    });
    const feed: SuiteTodayFeed = {
      schemaVersion: 1,
      appId: "reader",
      generatedAt: new Date().toISOString(),
      counts: {
        saved: all.length,
        annotated: annotatedCount,
        unread: unannotatedCount,
      },
      items,
      truncated: all.length > SUITE_LIMITS.items,
    };
    res.json(feed);
  });

  // ── Settings ─────────────────────────────────────────────────────────────
  app.get("/api/settings", (_req, res) => {
    res.json(store.getSettings());
  });

  app.patch("/api/settings", (req, res) => {
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "設定格式不正確。");
    res.json(store.saveSettings(parsed.data));
  });

  // ── Folders ──────────────────────────────────────────────────────────────
  app.get("/api/folders", (_req, res) => {
    res.json(store.listFolders());
  });

  app.post("/api/folders", (req, res) => {
    const parsed = createFolderSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請輸入有效的資料夾名稱。");
    res.status(201).json(store.createFolder(parsed.data.name, parsed.data.color));
  });

  app.patch("/api/folders/:id", (req, res) => {
    const parsed = createFolderSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請輸入有效的資料夾名稱。");
    res.json(store.renameFolder(req.params.id, parsed.data.name, parsed.data.color));
  });

  app.delete("/api/folders/:id", (req, res) => {
    store.deleteFolder(req.params.id);
    res.json({ ok: true });
  });

  // ── Pages ────────────────────────────────────────────────────────────────
  app.get("/api/pages", (_req, res) => {
    res.json({
      pages: store.listPages(),
      folders: store.listFolders(),
    });
  });

  app.get("/api/pages/:id", (req, res) => {
    const page = store.getPage(req.params.id);
    if (!page) throw new AppError(404, "找不到此頁面。");
    res.json(page);
  });

  app.post("/api/pages", async (req, res) => {
    const parsed = createPageSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請輸入網址或貼上內容。");

    const { url, content, title, folderId, forceRefetch } = parsed.data;
    const trimmedInput = (url ?? content ?? "").trim();
    if (!trimmedInput) throw new AppError(400, "請輸入網址或貼上想閱讀的內容。");

    const looksLikeUrl = Boolean(url) || (!content && /^https?:\/\/\S+$/i.test(trimmedInput));
    if (looksLikeUrl) {
      const targetUrl = validatePublicUrl(url || trimmedInput);
      if (!forceRefetch) {
        const existing = store.findByUrl(targetUrl.href);
        if (existing) {
          res.status(200).json({ page: existing, reused: true });
          return;
        }
      }
      const controller = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on("close", onClose);
      let fetched: Awaited<ReturnType<typeof htmlFetcher>>;
      try {
        fetched = await htmlFetcher(targetUrl.href, controller.signal);
      } finally {
        res.off("close", onClose);
      }
      if (!forceRefetch) {
        const existingFinal = store.findByUrl(fetched.finalUrl.href);
        if (existingFinal) {
          res.status(200).json({ page: existingFinal, reused: true });
          return;
        }
      }
      const extracted = extractBlocksFromHtml(fetched.html, fetched.finalUrl, fetched.contentType);
      const saved = store.createPage({
        sourceKind: "url",
        url: fetched.finalUrl.href,
        siteName: extracted.siteName,
        title: title?.trim() || extracted.title,
        excerpt: extracted.excerpt,
        blocks: extracted.blocks,
        folderId: folderId ?? null,
      });
      res.status(201).json({ page: saved, reused: false });
      return;
    }

    const extracted = parsePastedContent(content || trimmedInput, title);
    const saved = store.createPage({
      sourceKind: "paste",
      title: extracted.title,
      excerpt: extracted.excerpt,
      blocks: extracted.blocks,
      folderId: folderId ?? null,
    });
    res.status(201).json({ page: saved, reused: false });
  });

  app.patch("/api/pages/:id", (req, res) => {
    const parsed = updatePageSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "更新欄位格式不正確。");
    res.json(store.updatePageMeta(req.params.id, parsed.data));
  });

  app.delete("/api/pages/:id", (req, res) => {
    store.deletePage(req.params.id);
    res.json({ ok: true });
  });

  // ── AI Doodle Markup & Manual Annotations ────────────────────────────────
  app.post("/api/pages/:id/annotate", async (req, res) => {
    const page = store.getPage(req.params.id);
    if (!page) throw new AppError(404, "找不到此頁面。");

    const parsedBody = annotateRequestSchema.safeParse(req.body);
    if (!parsedBody.success) throw new AppError(400, "標註密度參數格式不正確。");

    const baseSettings = store.getSettings();
    const settings = {
      ...baseSettings,
      annotationDensity: parsedBody.data?.density ?? baseSettings.annotationDensity ?? "balanced",
    };
    const folders = store.listFolders();
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", onClose);

    const wantsStream = String(req.headers.accept ?? "").includes("application/x-ndjson");
    const stages = [
      "正在拆解頁面段落與圖表內容…",
      "正在以螢光筆與手繪線條標記重點文句與圖形座標…",
      "正在撰寫頁邊手寫筆記並分類主題…",
      "正在比對 BELL Explain 知識庫連結…",
    ];
    let stageIdx = 0;
    let stageTimer: NodeJS.Timeout | undefined;

    const sendEvent = (payload: unknown) => {
      if (!res.destroyed && !res.writableEnded) {
        res.write(`${JSON.stringify(payload)}\n`);
      }
    };

    if (wantsStream) {
      res.status(200);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      sendEvent({ type: "stage", message: stages[0] });
      stageTimer = setInterval(() => {
        stageIdx = Math.min(stageIdx + 1, stages.length - 1);
        sendEvent({ type: "stage", message: stages[stageIdx] });
      }, 3800);
    }

    try {
      const aiResult = await annotatePageWithAI(
        page,
        folders,
        settings,
        controller.signal,
        aiRunner,
      );

      let assignedFolderId = page.folderId;
      if (assignedFolderId === null && settings.autoFolder && aiResult.suggestedFolder) {
        const folder = store.createFolder(aiResult.suggestedFolder);
        assignedFolderId = folder.id;
      }

      const updated = store.replaceAiAnnotations(page.id, {
        topic: aiResult.topic,
        tags: aiResult.tags,
        summary: aiResult.summary,
        folderId: assignedFolderId,
        annotations: aiResult.annotations,
      });

      const explain = await explainBridge.matchForPage(updated);
      const result = { page: updated, folders: store.listFolders(), explain };
      if (wantsStream) {
        sendEvent({ type: "complete", ...result });
        res.end();
      } else {
        res.json(result);
      }
    } catch (err) {
      if (!wantsStream) throw err;
      if (!controller.signal.aborted) {
        const { message } = publicError(err);
        sendEvent({ type: "error", message });
      }
      if (!res.writableEnded) res.end();
    } finally {
      if (stageTimer) clearInterval(stageTimer);
      res.off("close", onClose);
    }
  });

  app.post("/api/pages/:id/annotate-selection", async (req, res) => {
    const page = store.getPage(req.params.id);
    if (!page) throw new AppError(404, "找不到此頁面。");
    const parsed = aiSelectionSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請選取一段有效的文字。");

    const settings = store.getSettings();
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", onClose);

    try {
      const item = await annotateSelectionWithAI(
        page,
        parsed.data,
        settings,
        controller.signal,
        aiRunner,
      );
      const created = store.addAnnotation(page.id, item);
      res.status(201).json({ annotation: created, page: store.getPage(page.id)! });
    } finally {
      res.off("close", onClose);
    }
  });

  app.post("/api/pages/:id/translate", async (req, res) => {
    const page = store.getPage(req.params.id);
    if (!page) throw new AppError(404, "找不到此頁面。");

    const settings = store.getSettings();
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", onClose);

    try {
      const translated = await translatePageWithAI(page, settings, controller.signal, aiRunner);
      const updated = store.saveTranslation(page.id, translated);
      res.json({ page: updated });
    } finally {
      res.off("close", onClose);
    }
  });

  app.post("/api/pages/:id/annotations", (req, res) => {
    const page = store.getPage(req.params.id);
    if (!page) throw new AppError(404, "找不到此頁面。");
    const parsed = manualAnnotationSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "批註內容格式不正確。");

    const block = page.blocks.find((b) => b.id === parsed.data.blockId);
    if (!block) throw new AppError(400, "找不到對應段落。");
    const isImage = block.kind === "image";
    const anchor = isImage
      ? {
          exactQuote: parsed.data.quote || block.alt || block.text || "圖片註記",
          startOffset: 0,
          endOffset: block.text.length,
        }
      : resolveQuoteAnchor(block.text, parsed.data.quote);
    if (!anchor) throw new AppError(400, "選取文字無法對齊段落內容。");

    const created = store.addAnnotation(page.id, {
      blockId: block.id,
      quote: anchor.exactQuote,
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
      style: parsed.data.style,
      color: parsed.data.color,
      ...(parsed.data.label ? { label: parsed.data.label } : {}),
      note: parsed.data.note,
      ...(parsed.data.topic ? { topic: parsed.data.topic } : {}),
      ...(isImage && parsed.data.anchorX !== undefined && parsed.data.anchorY !== undefined
        ? { anchorX: parsed.data.anchorX, anchorY: parsed.data.anchorY }
        : {}),
      ...(parsed.data.sketch ? { sketch: parsed.data.sketch } : {}),
      source: "user",
    });
    res.status(201).json({ annotation: created, page: store.getPage(page.id)! });
  });

  app.delete("/api/pages/:id/annotations/:annotationId", (req, res) => {
    store.deleteAnnotation(req.params.id, req.params.annotationId);
    res.json({ ok: true, page: store.getPage(req.params.id) });
  });

  // ── BELL Explain Topic Connection ────────────────────────────────────────
  app.get("/api/pages/:id/explain-links", async (req, res) => {
    const page = store.getPage(req.params.id);
    if (!page) throw new AppError(404, "找不到此頁面。");
    const refresh = req.query.refresh === "1";
    res.json(await explainBridge.matchForPage(page, refresh));
  });

  app.get("/api/explain/topics", async (req, res) => {
    const refresh = req.query.refresh === "1";
    res.json(await explainBridge.listAllTopics(refresh));
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "找不到此 API 路徑。" });
  });

  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get("/{*path}", (_req, res) => {
      res.sendFile(resolve(distDir, "index.html"));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: "JSON 格式不正確。" });
      return;
    }
    const { status, message } = publicError(err);
    res.status(status).json({ error: message });
  });

  return app;
}
