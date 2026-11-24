import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  AI_PROVIDERS,
  ANNOTATION_DENSITIES,
  INK_COLORS,
  type AnnotationDensity,
  type AnnotationSketch,
  type Folder,
  type InkColor,
  type InkStyle,
  type InteractiveBlock,
  type InteractiveBlockKind,
  type InteractivePayload,
  type PageAnnotation,
  type ProviderSettings,
  type ReaderBlock,
  type SavedPage,
  type SavedPageSummary,
} from "../shared/types.js";
import { AppError } from "./errors.js";
import { resolveQuoteAnchor } from "./extractor.js";

const DEFAULT_SETTINGS: ProviderSettings = {
  provider: "codex",
  model: "",
  autoFolder: true,
  annotationDensity: "balanced",
};

interface PageRow {
  id: string;
  source_kind: "url" | "paste" | "pdf";
  url: string | null;
  site_name: string | null;
  title: string;
  excerpt: string;
  blocks_json: string;
  translated_title: string | null;
  translated_blocks_json: string | null;
  topic: string;
  tags_json: string;
  summary: string | null;
  folder_id: string | null;
  has_pdf: number | null;
  pdf_page_count: number | null;
  annotated_at: string | null;
  translated_at: string | null;
  created_at: string;
  updated_at: string;
  annotation_count?: number;
}

interface InteractiveBlockRow {
  id: string;
  page_id: string;
  after_block_id: string | null;
  quote: string | null;
  kind: InteractiveBlockKind;
  title: string;
  summary: string;
  payload_json: string;
  state_json: string | null;
  source: "ai" | "deterministic";
  created_at: string;
  updated_at: string;
}

interface AnnotationRow {
  id: string;
  page_id: string;
  block_id: string;
  quote: string;
  translated_quote: string | null;
  start_offset: number;
  end_offset: number;
  style: InkStyle;
  color: InkColor;
  label: string | null;
  note: string;
  topic: string | null;
  anchor_x: number | null;
  anchor_y: number | null;
  sketch_json: string | null;
  source: "ai" | "user";
  created_at: string;
}

export class ReaderStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        url TEXT,
        site_name TEXT,
        title TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        blocks_json TEXT NOT NULL,
        topic TEXT NOT NULL DEFAULT '未分類',
        tags_json TEXT NOT NULL DEFAULT '[]',
        summary TEXT,
        folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
        annotated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pages_url ON pages(url) WHERE url IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_pages_updated ON pages(updated_at DESC);

      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        block_id TEXT NOT NULL,
        quote TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        style TEXT NOT NULL,
        color TEXT NOT NULL,
        label TEXT,
        note TEXT NOT NULL,
        topic TEXT,
        anchor_x REAL,
        anchor_y REAL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_annotations_page ON annotations(page_id);

      CREATE TABLE IF NOT EXISTS interactive_blocks (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        after_block_id TEXT,
        quote TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state_json TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_interactive_blocks_page ON interactive_blocks(page_id);

      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      );
    `);

    const cols = this.db.prepare("PRAGMA table_info(annotations)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("anchor_x")) this.db.exec("ALTER TABLE annotations ADD COLUMN anchor_x REAL");
    if (!colNames.has("anchor_y")) this.db.exec("ALTER TABLE annotations ADD COLUMN anchor_y REAL");
    if (!colNames.has("translated_quote")) this.db.exec("ALTER TABLE annotations ADD COLUMN translated_quote TEXT");
    if (!colNames.has("sketch_json")) this.db.exec("ALTER TABLE annotations ADD COLUMN sketch_json TEXT");

    const pageCols = this.db.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
    const pageColNames = new Set(pageCols.map((c) => c.name));
    if (!pageColNames.has("translated_title")) this.db.exec("ALTER TABLE pages ADD COLUMN translated_title TEXT");
    if (!pageColNames.has("translated_blocks_json")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN translated_blocks_json TEXT");
    }
    if (!pageColNames.has("translated_at")) this.db.exec("ALTER TABLE pages ADD COLUMN translated_at TEXT");
    if (!pageColNames.has("has_pdf")) this.db.exec("ALTER TABLE pages ADD COLUMN has_pdf INTEGER NOT NULL DEFAULT 0");
    if (!pageColNames.has("pdf_page_count")) this.db.exec("ALTER TABLE pages ADD COLUMN pdf_page_count INTEGER");
  }

  close(): void {
    this.db.close();
  }

  getSettings(): ProviderSettings {
    const row = this.db.prepare("SELECT json FROM settings WHERE id = 1").get() as { json: string } | undefined;
    if (!row) return { ...DEFAULT_SETTINGS };
    try {
      const parsed = JSON.parse(row.json) as Partial<ProviderSettings>;
      return {
        provider:
          typeof parsed.provider === "string" && (AI_PROVIDERS as readonly string[]).includes(parsed.provider)
            ? (parsed.provider as ProviderSettings["provider"])
            : "codex",
        model: typeof parsed.model === "string" ? parsed.model.slice(0, 160) : "",
        autoFolder: typeof parsed.autoFolder === "boolean" ? parsed.autoFolder : true,
        annotationDensity:
          typeof parsed.annotationDensity === "string" &&
          (ANNOTATION_DENSITIES as readonly string[]).includes(parsed.annotationDensity)
            ? (parsed.annotationDensity as AnnotationDensity)
            : "balanced",
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings(patch: Partial<ProviderSettings>): ProviderSettings {
    const next: ProviderSettings = {
      ...this.getSettings(),
      ...(patch.provider ? { provider: patch.provider } : {}),
      ...(patch.model !== undefined ? { model: patch.model.trim().slice(0, 160) } : {}),
      ...(patch.autoFolder !== undefined ? { autoFolder: patch.autoFolder } : {}),
      ...(patch.annotationDensity ? { annotationDensity: patch.annotationDensity } : {}),
    };
    this.db
      .prepare(
        "INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      )
      .run(JSON.stringify(next));
    return next;
  }

  listFolders(): Folder[] {
    const rows = this.db
      .prepare(`
        SELECT f.id, f.name, f.color, f.created_at, COUNT(p.id) AS page_count
        FROM folders f
        LEFT JOIN pages p ON p.folder_id = f.id
        GROUP BY f.id
        ORDER BY f.created_at ASC
      `)
      .all() as Array<{ id: string; name: string; color: InkColor; created_at: string; page_count: number }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      pageCount: Number(r.page_count),
      createdAt: r.created_at,
    }));
  }

  createFolder(name: string, color?: InkColor): Folder {
    const clean = name.trim().slice(0, 48);
    if (!clean) throw new AppError(400, "請輸入資料夾名稱。");
    const existing = this.db
      .prepare("SELECT id FROM folders WHERE lower(name) = lower(?)")
      .get(clean) as { id: string } | undefined;
    if (existing) {
      const found = this.listFolders().find((f) => f.id === existing.id);
      if (found) return found;
    }
    const id = randomUUID();
    const chosenColor = color ?? INK_COLORS[this.listFolders().length % INK_COLORS.length];
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO folders (id, name, color, created_at) VALUES (?, ?, ?, ?)")
      .run(id, clean, chosenColor, now);
    return { id, name: clean, color: chosenColor, pageCount: 0, createdAt: now };
  }

  renameFolder(id: string, name: string, color?: InkColor): Folder {
    const clean = name.trim().slice(0, 48);
    if (!clean) throw new AppError(400, "請輸入資料夾名稱。");
    const current = this.listFolders().find((f) => f.id === id);
    if (!current) throw new AppError(404, "找不到此資料夾。");
    const conflict = this.db
      .prepare("SELECT id FROM folders WHERE lower(name) = lower(?) AND id != ?")
      .get(clean, id) as { id: string } | undefined;
    if (conflict) throw new AppError(409, "已有同名資料夾。");
    this.db
      .prepare("UPDATE folders SET name = ?, color = ? WHERE id = ?")
      .run(clean, color ?? current.color, id);
    return { ...current, name: clean, color: color ?? current.color };
  }

  deleteFolder(id: string): void {
    const res = this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
    if (!res.changes) throw new AppError(404, "找不到此資料夾。");
  }

  private mapSummary(row: PageRow, annotationCount: number): SavedPageSummary {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(row.tags_json);
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
    } catch {
      tags = [];
    }
    return {
      id: row.id,
      sourceKind: row.source_kind,
      ...(row.url ? { url: row.url } : {}),
      ...(row.site_name ? { siteName: row.site_name } : {}),
      title: row.title,
      excerpt: row.excerpt,
      topic: row.topic,
      tags,
      ...(row.summary ? { summary: row.summary } : {}),
      folderId: row.folder_id,
      ...(row.has_pdf ? { hasPdf: true } : {}),
      ...(row.pdf_page_count != null ? { pdfPageCount: row.pdf_page_count } : {}),
      annotationCount,
      ...(row.annotated_at ? { annotatedAt: row.annotated_at } : {}),
      ...(row.translated_at ? { translatedAt: row.translated_at } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapInteractiveBlock(row: InteractiveBlockRow): InteractiveBlock {
    let payload: InteractivePayload = {};
    try {
      payload = JSON.parse(row.payload_json) as InteractivePayload;
    } catch {
      payload = {};
    }
    let state: Record<string, unknown> | undefined;
    if (row.state_json) {
      try {
        const parsed = JSON.parse(row.state_json);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          state = parsed as Record<string, unknown>;
        }
      } catch {
        state = undefined;
      }
    }
    return {
      id: row.id,
      pageId: row.page_id,
      afterBlockId: row.after_block_id,
      ...(row.quote ? { quote: row.quote } : {}),
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      payload,
      ...(state ? { state } : {}),
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapAnnotation(row: AnnotationRow): PageAnnotation {
    let sketch: AnnotationSketch | undefined;
    if (row.sketch_json) {
      try {
        const parsed = JSON.parse(row.sketch_json) as AnnotationSketch;
        const hasCanvas =
          parsed?.kind === "canvas" && Array.isArray(parsed.elements) && parsed.elements.length >= 2;
        const hasNodes = Array.isArray(parsed?.nodes) && parsed.nodes.length >= 2;
        if (hasCanvas || hasNodes) {
          sketch = parsed;
        }
      } catch {
        sketch = undefined;
      }
    }
    return {
      id: row.id,
      pageId: row.page_id,
      blockId: row.block_id,
      quote: row.quote,
      ...(row.translated_quote ? { translatedQuote: row.translated_quote } : {}),
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      style: row.style,
      color: row.color,
      ...(row.label ? { label: row.label } : {}),
      note: row.note,
      ...(row.topic ? { topic: row.topic } : {}),
      ...(row.anchor_x !== null && row.anchor_y !== null ? { anchorX: row.anchor_x, anchorY: row.anchor_y } : {}),
      ...(sketch ? { sketch } : {}),
      source: row.source,
      createdAt: row.created_at,
    };
  }

  listPages(): SavedPageSummary[] {
    const rows = this.db
      .prepare(`
        SELECT p.*, COUNT(a.id) AS annotation_count
        FROM pages p
        LEFT JOIN annotations a ON a.page_id = p.id
        GROUP BY p.id
        ORDER BY p.updated_at DESC
      `)
      .all() as unknown as PageRow[];

    return rows.map((row) => this.mapSummary(row, Number(row.annotation_count ?? 0)));
  }

  findByUrl(url: string): SavedPage | undefined {
    const row = this.db
      .prepare("SELECT id FROM pages WHERE url = ? ORDER BY updated_at DESC LIMIT 1")
      .get(url) as { id: string } | undefined;
    return row ? this.getPage(row.id) : undefined;
  }

  getPage(id: string): SavedPage | undefined {
    const row = this.db.prepare("SELECT * FROM pages WHERE id = ?").get(id) as PageRow | undefined;
    if (!row) return undefined;
    const annRows = this.db
      .prepare("SELECT * FROM annotations WHERE page_id = ? ORDER BY created_at ASC")
      .all(id) as unknown as AnnotationRow[];
    const annotations = annRows.map((a) => this.mapAnnotation(a));
    const interactiveRows = this.db
      .prepare("SELECT * FROM interactive_blocks WHERE page_id = ? ORDER BY created_at ASC")
      .all(id) as unknown as InteractiveBlockRow[];
    const interactiveBlocks = interactiveRows.map((r) => this.mapInteractiveBlock(r));
    let blocks: ReaderBlock[] = [];
    try {
      blocks = JSON.parse(row.blocks_json!) as ReaderBlock[];
    } catch {
      blocks = [];
    }
    let translatedBlocks: ReaderBlock[] | undefined;
    if (row.translated_blocks_json) {
      try {
        translatedBlocks = JSON.parse(row.translated_blocks_json) as ReaderBlock[];
      } catch {
        translatedBlocks = undefined;
      }
    }
    return {
      ...this.mapSummary(row, annotations.length),
      blocks,
      ...(row.translated_title ? { translatedTitle: row.translated_title } : {}),
      ...(translatedBlocks ? { translatedBlocks } : {}),
      annotations,
      interactiveBlocks,
    };
  }

  createPage(input: {
    sourceKind: "url" | "paste" | "pdf";
    url?: string;
    siteName?: string;
    title: string;
    excerpt: string;
    blocks: ReaderBlock[];
    folderId?: string | null;
    topic?: string;
    hasPdf?: boolean;
    pdfPageCount?: number;
  }): SavedPage {
    const id = randomUUID();
    const now = new Date().toISOString();
    const folderId = input.folderId ?? null;
    if (folderId && !this.listFolders().some((f) => f.id === folderId)) {
      throw new AppError(400, "指定的資料夾不存在。");
    }
    this.db
      .prepare(`
        INSERT INTO pages (
          id, source_kind, url, site_name, title, excerpt, blocks_json, topic, tags_json, folder_id, has_pdf, pdf_page_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.sourceKind,
        input.url ?? null,
        input.siteName ?? null,
        input.title.slice(0, 120),
        input.excerpt.slice(0, 200),
        JSON.stringify(input.blocks),
        (input.topic || "未分類").slice(0, 40),
        folderId,
        input.hasPdf ? 1 : 0,
        input.pdfPageCount ?? null,
        now,
        now,
      );
    return this.getPage(id)!;
  }

  updatePageSnapshot(
    id: string,
    snapshot: {
      sourceKind?: "url" | "paste" | "pdf";
      url?: string;
      siteName?: string;
      title: string;
      excerpt: string;
      blocks: ReaderBlock[];
      hasPdf?: boolean;
      pdfPageCount?: number;
    },
  ): SavedPage {
    const current = this.getPage(id);
    if (!current) throw new AppError(404, "找不到此頁面。");
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          UPDATE pages
          SET source_kind = ?, url = ?, site_name = ?, title = ?, excerpt = ?, blocks_json = ?,
              has_pdf = ?, pdf_page_count = ?, translated_title = NULL, translated_blocks_json = NULL,
              translated_at = NULL, updated_at = ?
          WHERE id = ?
        `)
        .run(
          snapshot.sourceKind ?? current.sourceKind,
          snapshot.url ?? current.url ?? null,
          snapshot.siteName ?? current.siteName ?? null,
          snapshot.title.slice(0, 120),
          snapshot.excerpt.slice(0, 200),
          JSON.stringify(snapshot.blocks),
          snapshot.hasPdf ? 1 : 0,
          snapshot.pdfPageCount ?? null,
          now,
          id,
        );

      const updateAnnStmt = this.db.prepare(
        "UPDATE annotations SET block_id = ?, start_offset = ?, end_offset = ?, quote = ? WHERE id = ?",
      );
      for (const ann of current.annotations) {
        const sameBlock = snapshot.blocks.find((b) => b.id === ann.blockId);
        const sameResolved = sameBlock ? resolveQuoteAnchor(sameBlock.text, ann.quote) : undefined;
        if (sameResolved && sameBlock) {
          updateAnnStmt.run(sameBlock.id, sameResolved.startOffset, sameResolved.endOffset, sameResolved.exactQuote, ann.id);
          continue;
        }
        for (const blk of snapshot.blocks) {
          const found = resolveQuoteAnchor(blk.text, ann.quote);
          if (found) {
            updateAnnStmt.run(blk.id, found.startOffset, found.endOffset, found.exactQuote, ann.id);
            break;
          }
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getPage(id)!;
  }

  updatePageMeta(
    id: string,
    patch: {
      title?: string;
      folderId?: string | null;
      topic?: string;
      tags?: string[];
      summary?: string;
    },
  ): SavedPage {
    const current = this.getPage(id);
    if (!current) throw new AppError(404, "找不到此頁面。");
    if (patch.folderId && !this.listFolders().some((f) => f.id === patch.folderId)) {
      throw new AppError(400, "指定的資料夾不存在。");
    }
    const now = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE pages
        SET title = ?, folder_id = ?, topic = ?, tags_json = ?, summary = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        (patch.title ?? current.title).trim().slice(0, 120) || current.title,
        patch.folderId === undefined ? current.folderId : patch.folderId,
        (patch.topic ?? current.topic).trim().slice(0, 40) || current.topic,
        JSON.stringify(patch.tags ?? current.tags),
        patch.summary === undefined ? (current.summary ?? null) : patch.summary,
        now,
        id,
      );
    return this.getPage(id)!;
  }

  saveTranslation(
    pageId: string,
    result: { title: string; blocks: ReaderBlock[]; annotationQuotes?: Record<string, string> },
  ): SavedPage {
    const current = this.getPage(pageId);
    if (!current) throw new AppError(404, "找不到此頁面。");
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          UPDATE pages
          SET translated_title = ?, translated_blocks_json = ?, translated_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          result.title.trim().slice(0, 160) || current.title,
          JSON.stringify(result.blocks),
          now,
          now,
          pageId,
        );
      if (result.annotationQuotes) {
        const updateQuote = this.db.prepare(
          "UPDATE annotations SET translated_quote = ? WHERE id = ? AND page_id = ?",
        );
        for (const [annId, tQuote] of Object.entries(result.annotationQuotes)) {
          if (tQuote.trim()) updateQuote.run(tQuote, annId, pageId);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getPage(pageId)!;
  }

  deletePage(id: string): void {
    const res = this.db.prepare("DELETE FROM pages WHERE id = ?").run(id);
    if (!res.changes) throw new AppError(404, "找不到此頁面。");
  }

  replaceAiAnnotations(
    pageId: string,
    result: {
      topic: string;
      tags: string[];
      summary: string;
      folderId?: string | null;
      annotations: Array<Omit<PageAnnotation, "id" | "pageId" | "source" | "createdAt">>;
    },
  ): SavedPage {
    const current = this.getPage(pageId);
    if (!current) throw new AppError(404, "找不到此頁面。");
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM annotations WHERE page_id = ? AND source = 'ai'").run(pageId);
      const insert = this.db.prepare(`
        INSERT INTO annotations (
          id, page_id, block_id, quote, translated_quote, start_offset, end_offset, style, color, label, note, topic, anchor_x, anchor_y, sketch_json, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?)
      `);
      for (const item of result.annotations) {
        insert.run(
          randomUUID(),
          pageId,
          item.blockId,
          item.quote,
          item.translatedQuote ?? null,
          item.startOffset,
          item.endOffset,
          item.style,
          item.color,
          item.label ?? null,
          item.note,
          item.topic ?? null,
          item.anchorX ?? null,
          item.anchorY ?? null,
          item.sketch ? JSON.stringify(item.sketch) : null,
          now,
        );
      }
      this.db
        .prepare(`
          UPDATE pages
          SET topic = ?, tags_json = ?, summary = ?, folder_id = ?, annotated_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          result.topic.slice(0, 40),
          JSON.stringify(result.tags.slice(0, 5)),
          result.summary.slice(0, 240),
          result.folderId === undefined ? current.folderId : result.folderId,
          now,
          now,
          pageId,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getPage(pageId)!;
  }

  addAnnotation(
    pageId: string,
    item: Omit<PageAnnotation, "id" | "pageId" | "createdAt">,
  ): PageAnnotation {
    const current = this.getPage(pageId);
    if (!current) throw new AppError(404, "找不到此頁面。");
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO annotations (
          id, page_id, block_id, quote, translated_quote, start_offset, end_offset, style, color, label, note, topic, anchor_x, anchor_y, sketch_json, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        pageId,
        item.blockId,
        item.quote,
        item.translatedQuote ?? null,
        item.startOffset,
        item.endOffset,
        item.style,
        item.color,
        item.label ?? null,
        item.note.slice(0, 320),
        item.topic ? item.topic.slice(0, 40) : null,
        item.anchorX ?? null,
        item.anchorY ?? null,
        item.sketch ? JSON.stringify(item.sketch) : null,
        item.source,
        now,
      );
    this.db
      .prepare("UPDATE pages SET updated_at = ?, annotated_at = COALESCE(annotated_at, ?) WHERE id = ?")
      .run(now, item.source === "ai" ? now : null, pageId);
    return {
      id,
      pageId,
      ...item,
      note: item.note.slice(0, 320),
      createdAt: now,
    };
  }

  deleteAnnotation(pageId: string, annotationId: string): void {
    const res = this.db
      .prepare("DELETE FROM annotations WHERE id = ? AND page_id = ?")
      .run(annotationId, pageId);
    if (!res.changes) throw new AppError(404, "找不到此筆標註。");
  }

  updateAnnotation(
    pageId: string,
    annotationId: string,
    patch: {
      note?: string;
      label?: string | null;
      topic?: string | null;
      style?: InkStyle;
      color?: InkColor;
    },
  ): PageAnnotation {
    const row = this.db
      .prepare("SELECT * FROM annotations WHERE id = ? AND page_id = ?")
      .get(annotationId, pageId) as AnnotationRow | undefined;
    if (!row) throw new AppError(404, "找不到此筆標註。");

    const nextNote = patch.note !== undefined ? patch.note.trim().slice(0, 320) : row.note;
    if (!nextNote) throw new AppError(400, "筆記內容不可為空。");
    const nextLabel = patch.label === undefined ? row.label : patch.label ? patch.label.trim().slice(0, 16) : null;
    const nextTopic = patch.topic === undefined ? row.topic : patch.topic ? patch.topic.trim().slice(0, 40) : null;
    const nextStyle = patch.style ?? row.style;
    const nextColor = patch.color ?? row.color;
    const now = new Date().toISOString();

    this.db
      .prepare(`
        UPDATE annotations
        SET note = ?, label = ?, topic = ?, style = ?, color = ?
        WHERE id = ? AND page_id = ?
      `)
      .run(nextNote, nextLabel, nextTopic, nextStyle, nextColor, annotationId, pageId);
    this.db.prepare("UPDATE pages SET updated_at = ? WHERE id = ?").run(now, pageId);

    const updated = this.db
      .prepare("SELECT * FROM annotations WHERE id = ? AND page_id = ?")
      .get(annotationId, pageId) as unknown as AnnotationRow;
    return this.mapAnnotation(updated);
  }

  getInteractiveBlock(pageId: string, blockId: string): InteractiveBlock | undefined {
    const row = this.db
      .prepare("SELECT * FROM interactive_blocks WHERE id = ? AND page_id = ?")
      .get(blockId, pageId) as InteractiveBlockRow | undefined;
    return row ? this.mapInteractiveBlock(row) : undefined;
  }

  addInteractiveBlock(
    pageId: string,
    input: {
      afterBlockId: string | null;
      quote?: string;
      kind: InteractiveBlockKind;
      title: string;
      summary: string;
      payload: InteractivePayload;
      state?: Record<string, unknown>;
      source: "ai" | "deterministic";
    },
  ): InteractiveBlock {
    const current = this.getPage(pageId);
    if (!current) throw new AppError(404, "找不到此頁面。");
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO interactive_blocks (
          id, page_id, after_block_id, quote, kind, title, summary, payload_json, state_json, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        pageId,
        input.afterBlockId,
        input.quote ? input.quote.slice(0, 300) : null,
        input.kind,
        input.title.trim().slice(0, 120) || "互動理解區塊",
        input.summary.trim().slice(0, 280),
        JSON.stringify(input.payload),
        input.state ? JSON.stringify(input.state) : null,
        input.source,
        now,
        now,
      );
    this.db.prepare("UPDATE pages SET updated_at = ? WHERE id = ?").run(now, pageId);
    return this.getInteractiveBlock(pageId, id)!;
  }

  updateInteractiveBlock(
    pageId: string,
    blockId: string,
    patch: {
      title?: string;
      summary?: string;
      payload?: InteractivePayload;
      state?: Record<string, unknown>;
      resetState?: boolean;
      source?: "ai" | "deterministic";
    },
  ): InteractiveBlock {
    const current = this.getInteractiveBlock(pageId, blockId);
    if (!current) throw new AppError(404, "找不到此互動區塊。");
    const now = new Date().toISOString();
    const nextState = patch.resetState
      ? {}
      : patch.state
        ? { ...(current.state ?? {}), ...patch.state }
        : current.state;
    this.db
      .prepare(`
        UPDATE interactive_blocks
        SET title = ?, summary = ?, payload_json = ?, state_json = ?, source = ?, updated_at = ?
        WHERE id = ? AND page_id = ?
      `)
      .run(
        patch.title !== undefined ? patch.title.trim().slice(0, 120) || current.title : current.title,
        patch.summary !== undefined ? patch.summary.trim().slice(0, 280) : current.summary,
        JSON.stringify(patch.payload ?? current.payload),
        nextState ? JSON.stringify(nextState) : null,
        patch.source ?? current.source,
        now,
        blockId,
        pageId,
      );
    this.db.prepare("UPDATE pages SET updated_at = ? WHERE id = ?").run(now, pageId);
    return this.getInteractiveBlock(pageId, blockId)!;
  }

  deleteInteractiveBlock(pageId: string, blockId: string): void {
    const res = this.db
      .prepare("DELETE FROM interactive_blocks WHERE id = ? AND page_id = ?")
      .run(blockId, pageId);
    if (!res.changes) throw new AppError(404, "找不到此互動區塊。");
  }
}
