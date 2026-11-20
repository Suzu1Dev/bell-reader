import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { AudioLines, Braces, Circle, Cpu, Highlighter, ListChecks, Pencil, PenLine, Plus, Sparkles, Trash2, Underline, X } from "lucide-react";
import {
  INK_COLORS,
  SKETCH_CURVE_SHAPES,
  SKETCH_KINDS,
  type AnnotationSketch,
  type InkColor,
  type InkStyle,
  type InteractiveBlock,
  type InteractiveBlockKind,
  type PageAnnotation,
  type ReaderBlock,
  type SavedPage,
  type SketchCurveShape,
  type SketchKind,
} from "../../shared/types";
import { explainDraftHref } from "../../shared/suite";
import HandSketch from "./HandSketch";
import InteractiveBlockCard from "./InteractiveBlockCard";
import {
  bracketPath,
  handBoxPath,
  handPinCirclePath,
  highlighterPath,
  layoutMarginNotes,
  leaderArrowPath,
  wavyUnderlinePath,
  type BoxRect,
} from "../lib/ink-geometry";

type NotePlacement = "inline-blank" | "under-block" | "left-margin" | "right-margin";

interface MeasuredAnchor {
  annotation: PageAnnotation;
  blockKind: ReaderBlock["kind"];
  rects: BoxRect[];
  bounds: BoxRect;
  firstRect: BoxRect;
  lastRect: BoxRect;
  spot?: { x: number; y: number };
  blockTextRight: number;
  blockBottom: number;
  blockIsSingleLine: boolean;
}

interface PlacedNoteMeta {
  mode: NotePlacement;
  top: number;
  left?: number;
  maxWidth?: number;
}

interface PendingSelection {
  blockId: string;
  quote: string;
  top: number;
  left: number;
  isImage?: boolean;
  anchorX?: number;
  anchorY?: number;
  spotX?: number;
  spotY?: number;
}

const STYLE_LABELS: Record<InkStyle, string> = {
  highlight: "重點",
  underline: "底線",
  box: "圈註",
  bracket: "段落",
};

const COLOR_NAMES: Record<InkColor, string> = {
  amber: "琥珀墨",
  mint: "松綠墨",
  violet: "藍紫墨",
  coral: "硃砂紅",
  sky: "鋼筆藍",
};

const SKETCH_KIND_LABELS: Record<SketchKind, string> = {
  canvas: "自由繪製",
  cycle: "循環",
  tree: "樹狀",
  venn: "交集",
  timeline: "時間軸",
  flow: "流程",
  compare: "對比",
  layers: "階層",
  axes: "趨勢",
};

const MANUAL_SKETCH_PRESETS = SKETCH_KINDS.filter((k) => k !== "canvas");

const SKETCH_SHAPE_LABELS: Record<SketchCurveShape, string> = {
  rise: "上升",
  drop: "下降",
  peak: "峰值",
  threshold: "閾值",
};

function parseSketchNodes(raw: string): string[] {
  return raw
    .split(/\s*(?:->|→|｜|\||,|、)\s*/)
    .map((s) => s.trim().slice(0, 24))
    .filter(Boolean)
    .slice(0, 5);
}

function summarizeSketchForExplain(sketch: AnnotationSketch): string {
  if (sketch.nodes.length > 0) return sketch.nodes.join(" → ");
  const texts = (sketch.elements ?? [])
    .map((el) => ("label" in el ? el.label : "text" in el ? el.text : ""))
    .filter(Boolean);
  return texts.join(" · ") || sketch.caption || "手繪概念圖";
}

function findRangeInElement(container: HTMLElement, start: number, end: number): Range | null {
  if (end <= start) return null;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let cursor = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const len = node.data.length;
    if (!startNode && start <= cursor + len) {
      startNode = node;
      startOffset = Math.max(0, start - cursor);
    }
    if (!endNode && end <= cursor + len) {
      endNode = node;
      endOffset = Math.max(0, end - cursor);
      break;
    }
    cursor += len;
  }

  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

function unionRects(rects: BoxRect[]): BoxRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.left);
    minY = Math.min(minY, r.top);
    maxX = Math.max(maxX, r.left + r.width);
    maxY = Math.max(maxY, r.top + r.height);
  }
  return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function findSubstrSpan(text: string, needle: string): { start: number; end: number } | null {
  const clean = needle.trim();
  if (!clean || !text) return null;
  const direct = text.indexOf(clean);
  if (direct >= 0) return { start: direct, end: direct + clean.length };
  const tokens = clean.split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (tokens.length > 1) {
    const match = new RegExp(tokens.join("\\s+")).exec(text);
    if (match?.[0]) return { start: match.index, end: match.index + match[0].length };
  }
  return null;
}

/** Resolve an annotation's visible text span against either original or translated text. */
function resolveDisplaySpan(text: string, ann: PageAnnotation): { start: number; end: number } | null {
  if (!text.trim()) return null;
  if (
    ann.startOffset >= 0 &&
    ann.endOffset > ann.startOffset &&
    ann.endOffset <= text.length &&
    text.slice(ann.startOffset, ann.endOffset) === ann.quote
  ) {
    return { start: ann.startOffset, end: ann.endOffset };
  }
  const direct = findSubstrSpan(text, ann.quote);
  if (direct) return direct;

  if (ann.translatedQuote) {
    const tr = findSubstrSpan(text, ann.translatedQuote);
    if (tr) return tr;
  }

  // Fallback for already-translated pages without mapped translatedQuote: anchor on shared technical tokens
  const techTokens = Array.from(new Set(ann.quote.match(/[A-Za-z0-9][A-Za-z0-9_./:-]{2,}/g) ?? [])).sort(
    (a, b) => b.length - a.length,
  );
  for (const tok of techTokens) {
    const idx = text.indexOf(tok);
    if (idx >= 0) return { start: idx, end: idx + tok.length };
  }

  if (ann.style === "bracket") {
    return { start: 0, end: text.length };
  }
  const stopMatch = /[。；！？\n]/.exec(text.slice(8, 38));
  const clauseEnd = stopMatch ? 8 + stopMatch.index : Math.min(text.length, 28);
  return clauseEnd > 0 ? { start: 0, end: clauseEnd } : null;
}

function renderInteractiveText(
  text: string,
  annotations: PageAnnotation[],
  activeId: string | null,
  onSelectAnnotation: (id: string) => void,
  showInk: boolean,
): ReactNode {
  if (!showInk || !annotations.length) return text;
  const resolved = annotations
    .map((a) => {
      const span = resolveDisplaySpan(text, a);
      return span ? { ann: a, start: span.start, end: span.end } : null;
    })
    .filter((item): item is { ann: PageAnnotation; start: number; end: number } => Boolean(item))
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const pieces: ReactNode[] = [];
  let cursor = 0;
  for (const { ann, start, end } of resolved) {
    if (start < cursor) continue;
    if (start > cursor) {
      pieces.push(text.slice(cursor, start));
    }
    const slice = text.slice(start, end);
    const isActive = activeId === ann.id;
    pieces.push(
      <mark
        key={ann.id}
        data-ann-id={ann.id}
        tabIndex={0}
        role="button"
        aria-label={`標註：${ann.label || STYLE_LABELS[ann.style]} — ${ann.note}`}
        className={`ink-text-hit ink-color-${ann.color} ${isActive ? "is-active" : ""}`}
        onClick={(e) => {
          if (!window.getSelection()?.isCollapsed) return;
          e.stopPropagation();
          onSelectAnnotation(ann.id);
        }}
        onMouseEnter={() => onSelectAnnotation(ann.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelectAnnotation(ann.id);
          }
        }}
      >
        {slice}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) {
    pieces.push(text.slice(cursor));
  }
  return pieces;
}

function PenNote({
  annotation,
  active,
  mode,
  explainOrigin,
  pageId,
  pageTitle,
  onActivate,
  onUpdate,
  onDelete,
  stylePos,
  noteRef,
}: {
  annotation: PageAnnotation;
  active: boolean;
  mode: NotePlacement | "compact";
  explainOrigin?: string;
  pageId: string;
  pageTitle: string;
  onActivate: () => void;
  onUpdate: (id: string, patch: { note: string; label?: string | null }) => Promise<void>;
  onDelete: (id: string) => void;
  stylePos?: { top?: number; left?: number; maxWidth?: number };
  noteRef?: (el: HTMLElement | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftNote, setDraftNote] = useState(annotation.note);
  const [draftLabel, setDraftLabel] = useState(annotation.label ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) {
      setDraftNote(annotation.note);
      setDraftLabel(annotation.label ?? "");
    }
  }, [annotation.note, annotation.label, editing]);

  const submitEdit = async () => {
    const clean = draftNote.trim();
    if (!clean || saving) return;
    setSaving(true);
    try {
      await onUpdate(annotation.id, {
        note: clean,
        label: draftLabel.trim() || null,
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const explainHref = useMemo(
    () =>
      explainDraftHref(
        explainOrigin,
        {
          title: annotation.topic ? `${pageTitle} · ${annotation.topic}` : pageTitle,
          text: `原文摘錄：\n「${annotation.quote}」\n\n頁邊筆記：\n${annotation.note}${
            annotation.sketch
              ? `\n\n[手繪圖解 (${SKETCH_KIND_LABELS[annotation.sketch.kind]})]：${summarizeSketchForExplain(annotation.sketch)}${
                  annotation.sketch.caption ? `（${annotation.sketch.caption}）` : ""
                }`
              : ""
          }`,
          back: `#/page/${pageId}`,
        },
        typeof window !== "undefined" ? window.location.hostname : "",
      ),
    [annotation, explainOrigin, pageId, pageTitle],
  );

  return (
    <aside
      ref={noteRef}
      className={`pen-note pen-ink-${annotation.color} is-${mode} ${annotation.sketch ? "has-sketch" : ""} ${active ? "is-active" : ""}`}
      style={
        stylePos
          ? {
              ...(stylePos.top !== undefined ? { top: `${stylePos.top}px` } : null),
              ...(stylePos.left !== undefined ? { left: `${stylePos.left}px` } : null),
              ...(stylePos.maxWidth !== undefined ? { maxWidth: `${stylePos.maxWidth}px` } : null),
            }
          : undefined
      }
      onMouseEnter={onActivate}
      onClick={onActivate}
    >
      <div className="pen-note-meta">
        <span className="pen-note-tag">
          {annotation.label || STYLE_LABELS[annotation.style]}
          {annotation.topic ? ` · ${annotation.topic}` : ""}
        </span>
        <span className="pen-note-actions">
          <button
            type="button"
            className="pen-note-btn"
            aria-label="編輯筆記"
            title="編輯筆記（或雙擊筆記文字）"
            onClick={(e) => {
              e.stopPropagation();
              setEditing((v) => !v);
            }}
          >
            <Pencil size={11} aria-hidden="true" />
          </button>
          {explainHref ? (
            <a
              href={explainHref}
              className="pen-note-btn"
              title="送到 BELL Explain 深入解釋"
              aria-label="送到 BELL Explain"
              onClick={(e) => e.stopPropagation()}
            >
              <AudioLines size={11} aria-hidden="true" />
              <span>Explain</span>
            </a>
          ) : null}
          <button
            type="button"
            className="pen-note-btn is-danger"
            aria-label="刪除此標註"
            title="刪除此標註"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(annotation.id);
            }}
          >
            <Trash2 size={11} aria-hidden="true" />
          </button>
        </span>
      </div>
      {editing ? (
        <form
          className="pen-edit-form"
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            void submitEdit();
          }}
        >
          <input
            type="text"
            className="pen-edit-label"
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
            placeholder="標籤（選填）"
            aria-label="標註標籤"
            maxLength={16}
          />
          <textarea
            className="pen-edit-textarea"
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            aria-label="編輯筆記內容"
            rows={2}
            maxLength={320}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(false);
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submitEdit();
              }
            }}
          />
          <div className="pen-edit-actions">
            <button type="button" className="pen-note-btn" onClick={() => setEditing(false)}>
              取消
            </button>
            <button type="submit" className="pen-note-btn is-save" disabled={saving || !draftNote.trim()}>
              {saving ? "儲存中…" : "儲存"}
            </button>
          </div>
        </form>
      ) : (
        <p
          className="pen-note-body"
          title="雙擊編輯筆記"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          <bdi>{annotation.note}</bdi>
        </p>
      )}
      {mode === "under-block" && annotation.sketch ? (
        <div className="pen-note-quote-ref" title={annotation.quote}>
          「{annotation.quote.length > 26 ? `${annotation.quote.slice(0, 26)}…` : annotation.quote}」
        </div>
      ) : null}
      {annotation.sketch ? (
        <HandSketch sketch={annotation.sketch} color={annotation.color} seed={annotation.id} />
      ) : null}
    </aside>
  );
}

/**
 * Compute arrow endpoints `(ax, ay) -> (nx, ny)` choosing the natural edge of the unboxed note
 * closest to the annotated phrase so arrows stay short, varied, and readable.
 */
function arrowEndpoints(
  anchor: MeasuredAnchor,
  mode: NotePlacement,
  noteBox: BoxRect,
): { ax: number; ay: number; nx: number; ny: number } | null {
  const { bounds, lastRect, annotation, spot } = anchor;

  if (anchor.blockKind === "image" && spot) {
    if (mode === "left-margin") {
      return {
        ax: spot.x - 13,
        ay: spot.y,
        nx: noteBox.left + noteBox.width + 6,
        ny: noteBox.top + Math.min(18, noteBox.height * 0.4),
      };
    }
    return {
      ax: spot.x + 13,
      ay: spot.y,
      nx: noteBox.left - 6,
      ny: noteBox.top + Math.min(18, noteBox.height * 0.4),
    };
  }

  if (mode === "inline-blank") {
    return {
      ax: lastRect.left + lastRect.width + 4,
      ay: lastRect.top + lastRect.height * 0.58,
      nx: noteBox.left - 5,
      ny: clamp(lastRect.top + lastRect.height * 0.5, noteBox.top + 8, noteBox.top + 22),
    };
  }

  if (mode === "under-block") {
    if (!anchor.blockIsSingleLine && anchor.blockBottom - (lastRect.top + lastRect.height) > 28) {
      return null;
    }
    const startX = clamp(bounds.left + Math.min(bounds.width * 0.35, 36), bounds.left + 8, bounds.left + bounds.width - 6);
    const startY = lastRect.top + lastRect.height + 2;
    const endX = clamp(startX + 10, noteBox.left + 12, noteBox.left + noteBox.width - 16);
    const endY = noteBox.top - 4;
    return { ax: startX, ay: startY, nx: endX, ny: endY };
  }

  if (mode === "left-margin") {
    const leftmost = anchor.rects.reduce((a, b) => (a.left < b.left ? a : b));
    return {
      ax: leftmost.left - 4,
      ay: leftmost.top + leftmost.height * 0.55,
      nx: noteBox.left + noteBox.width + 6,
      ny: noteBox.top + Math.min(18, noteBox.height * 0.4),
    };
  }

  // right-margin
  const rightmost = anchor.rects.reduce((a, b) => (a.left + a.width > b.left + b.width ? a : b));
  const startX = annotation.style === "bracket" ? bounds.left + bounds.width + 12 : rightmost.left + rightmost.width + 5;
  const startY = annotation.style === "bracket" ? bounds.top + bounds.height * 0.5 : rightmost.top + rightmost.height * 0.55;
  return {
    ax: startX,
    ay: startY,
    nx: noteBox.left - 6,
    ny: noteBox.top + Math.min(18, noteBox.height * 0.4),
  };
}

function renderPlainTranslatedBlock(block: ReaderBlock): ReactNode {
  if (block.kind === "heading") {
    const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
    return <Tag className={`reader-heading level-${block.level ?? 2}`}>{block.text}</Tag>;
  }
  if (block.kind === "code") {
    return (
      <pre className="reader-code-wrap">
        {block.language ? <span className="reader-code-lang">{block.language}</span> : null}
        <code className="reader-code">{block.text}</code>
      </pre>
    );
  }
  if (block.kind === "quote") {
    return <blockquote className="reader-quote">{block.text}</blockquote>;
  }
  if (block.kind === "list") {
    return (
      <div className="reader-list-item">
        <span className="reader-bullet" aria-hidden="true" />
        <div className="reader-list-text">{block.text}</div>
      </div>
    );
  }
  if (block.kind === "table") {
    const rows = block.tableRows?.length
      ? block.tableRows
      : block.text
          .split("\n")
          .map((r) => r.split(" | ").map((c) => c.trim()))
          .filter((r) => r.some(Boolean));
    return (
      <div className="reader-table-wrap">
        <table className="reader-table">
          {rows.length > 0 ? (
            <thead>
              <tr>
                {rows[0].map((c, idx) => (
                  <th key={idx}>{c}</th>
                ))}
              </tr>
            </thead>
          ) : null}
          {rows.length > 1 ? (
            <tbody>
              {rows.slice(1).map((row, rIdx) => (
                <tr key={rIdx}>
                  {row.map((c, cIdx) => (
                    <td key={cIdx}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          ) : null}
        </table>
      </div>
    );
  }
  if (block.kind === "image" && block.imageUrl) {
    return (
      <figure className="reader-figure">
        <figcaption>{block.alt || block.text}</figcaption>
      </figure>
    );
  }
  return <p className="reader-paragraph">{block.text}</p>;
}

export default function InkStage({
  page,
  theme,
  showInk,
  translationMode = "original",
  translatedBlocks,
  readingFont,
  explainOrigin,
  selectionBusy,
  interactiveBusy = false,
  upgradingBlockId = null,
  focusRequest,
  onAiSelection,
  onManualSelection,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onCreateInteractiveBlock,
  onUpdateInteractiveState,
  onUpgradeInteractiveBlock,
  onDeleteInteractiveBlock,
}: {
  page: SavedPage;
  theme: "dark" | "light";
  showInk: boolean;
  translationMode?: "original" | "bilingual" | "translated";
  translatedBlocks?: ReaderBlock[];
  readingFont: "sans" | "serif";
  explainOrigin?: string;
  selectionBusy: boolean;
  interactiveBusy?: boolean;
  upgradingBlockId?: string | null;
  focusRequest?: { kind: "block" | "ann"; id: string; nonce: number } | null;
  onAiSelection: (opts: {
    blockId: string;
    quote: string;
    style: InkStyle;
    color: InkColor;
  }) => Promise<void>;
  onManualSelection: (opts: {
    blockId: string;
    quote: string;
    style: InkStyle;
    color: InkColor;
    label?: string;
    note: string;
    anchorX?: number;
    anchorY?: number;
    sketch?: AnnotationSketch;
  }) => Promise<void>;
  onUpdateAnnotation: (annotationId: string, patch: { note: string; label?: string | null }) => Promise<void>;
  onDeleteAnnotation: (annotationId: string) => void;
  onCreateInteractiveBlock: (opts: {
    afterBlockId: string | null;
    quote?: string;
    kind: InteractiveBlockKind;
    prompt?: string;
  }) => Promise<void>;
  onUpdateInteractiveState: (blockId: string, state: Record<string, unknown>) => Promise<void>;
  onUpgradeInteractiveBlock: (blockId: string) => Promise<void>;
  onDeleteInteractiveBlock: (blockId: string) => Promise<void>;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const paperRef = useRef<HTMLElement | null>(null);
  const blockRefs = useRef<Map<string, HTMLElement>>(new Map());
  const imageRefs = useRef<Map<string, HTMLImageElement>>(new Map());
  const noteRefs = useRef<Map<string, HTMLElement>>(new Map());

  const [activeId, setActiveId] = useState<string | null>(null);
  const [isDesktopRail, setIsDesktopRail] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth >= 1120 : true,
  );
  const [measured, setMeasured] = useState<MeasuredAnchor[]>([]);
  const [paperSpan, setPaperSpan] = useState<{ left: number; width: number }>({ left: 210, width: 620 });
  const [noteHeights, setNoteHeights] = useState<Record<string, number>>({});
  const [noteBoxes, setNoteBoxes] = useState<Record<string, BoxRect>>({});

  const [selection, setSelection] = useState<PendingSelection | null>(null);
  const [penStyle, setPenStyle] = useState<InkStyle>("highlight");
  const [penColor, setPenColor] = useState<InkColor>("sky");
  const [manualOpen, setManualOpen] = useState(false);
  const [selectionInteractiveOpen, setSelectionInteractiveOpen] = useState(false);
  const [selectionInteractivePrompt, setSelectionInteractivePrompt] = useState("");
  const [blockPickerId, setBlockPickerId] = useState<string | null>(null);
  const [manualLabel, setManualLabel] = useState("");
  const [manualNote, setManualNote] = useState("");
  const [manualSketchKind, setManualSketchKind] = useState<SketchKind | "none">("none");
  const [manualSketchNodes, setManualSketchNodes] = useState("");
  const [manualSketchShape, setManualSketchShape] = useState<SketchCurveShape>("rise");

  const isTranslatedView = translationMode === "translated";
  const isBilingualView = translationMode === "bilingual" && Boolean(translatedBlocks?.length);

  const interactiveByAfterBlock = useMemo(() => {
    const map = new Map<string, InteractiveBlock[]>();
    for (const ib of page.interactiveBlocks ?? []) {
      const key = ib.afterBlockId && page.blocks.some((b) => b.id === ib.afterBlockId) ? ib.afterBlockId : "__top__";
      const list = map.get(key) ?? [];
      list.push(ib);
      map.set(key, list);
    }
    return map;
  }, [page.interactiveBlocks, page.blocks]);

  const resetManualDraft = useCallback((open = false) => {
    setManualOpen(open);
    setManualLabel("");
    setManualNote("");
    setManualSketchKind("none");
    setManualSketchNodes("");
    setManualSketchShape("rise");
  }, []);

  const draftSketch = useMemo<AnnotationSketch | undefined>(() => {
    if (manualSketchKind === "none") return undefined;
    const nodes = parseSketchNodes(manualSketchNodes);
    if (nodes.length < 2) return undefined;
    return {
      kind: manualSketchKind,
      nodes,
      ...(manualSketchKind === "axes" ? { shape: manualSketchShape } : {}),
    };
  }, [manualSketchKind, manualSketchNodes, manualSketchShape]);

  const blockKindById = useMemo(() => {
    const m = new Map<string, ReaderBlock["kind"]>();
    for (const b of page.blocks) m.set(b.id, b.kind);
    return m;
  }, [page.blocks]);

  const annotationsByBlock = useMemo(() => {
    const map = new Map<string, PageAnnotation[]>();
    for (const ann of page.annotations) {
      const list = map.get(ann.blockId) ?? [];
      list.push(ann);
      map.set(ann.blockId, list);
    }
    return map;
  }, [page.annotations]);

  const recomputeGeometry = useCallback(() => {
    const stageEl = stageRef.current;
    const paperEl = paperRef.current;
    if (!stageEl || !paperEl) return;

    const stageRect = stageEl.getBoundingClientRect();
    const desktop = stageRect.width >= 880;
    setIsDesktopRail(desktop);

    const paperRect = paperEl.getBoundingClientRect();
    const pLeft = paperRect.left - stageRect.left;
    const pWidth = paperRect.width;

    // Measure full text geometry of each block once so inline placement never overlaps wrapped text.
    const blockGeom = new Map<string, { textRight: number; bottom: number; singleLine: boolean }>();
    for (const [bId, bEl] of blockRefs.current.entries()) {
      const br = bEl.getBoundingClientRect();
      let textRight = br.right - stageRect.left;
      let singleLine = br.height <= 42;
      try {
        const fullRange = document.createRange();
        fullRange.selectNodeContents(bEl);
        const fullRects = Array.from(fullRange.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
        if (fullRects.length > 0) {
          textRight = Math.max(...fullRects.map((r) => r.right - stageRect.left));
          const minTop = Math.min(...fullRects.map((r) => r.top));
          const maxBottom = Math.max(...fullRects.map((r) => r.bottom));
          const firstH = fullRects[0].height || 24;
          singleLine = maxBottom - minTop <= firstH * 1.45;
        }
      } catch {
        // Fallback to element box
      }
      blockGeom.set(bId, {
        textRight,
        bottom: br.bottom - stageRect.top,
        singleLine,
      });
    }

    const nextMeasured: MeasuredAnchor[] = [];
    for (const ann of page.annotations) {
      const bKind = blockKindById.get(ann.blockId) ?? "paragraph";
      if (bKind === "image") {
        const targetEl = imageRefs.current.get(ann.blockId) ?? blockRefs.current.get(ann.blockId);
        if (!targetEl) continue;
        const r = targetEl.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const imgBox: BoxRect = {
          left: r.left - stageRect.left,
          top: r.top - stageRect.top,
          width: r.width,
          height: r.height,
        };
        if (ann.anchorX !== undefined && ann.anchorY !== undefined) {
          const spotX = imgBox.left + clamp(ann.anchorX, 0.03, 0.97) * imgBox.width;
          const spotY = imgBox.top + clamp(ann.anchorY, 0.04, 0.96) * imgBox.height;
          const pinRect: BoxRect = { left: spotX - 13, top: spotY - 13, width: 26, height: 26 };
          nextMeasured.push({
            annotation: ann,
            blockKind: "image",
            rects: [pinRect],
            bounds: pinRect,
            firstRect: pinRect,
            lastRect: pinRect,
            spot: { x: spotX, y: spotY },
            blockTextRight: imgBox.left + imgBox.width,
            blockBottom: imgBox.top + imgBox.height,
            blockIsSingleLine: false,
          });
        } else {
          nextMeasured.push({
            annotation: ann,
            blockKind: "image",
            rects: [imgBox],
            bounds: imgBox,
            firstRect: imgBox,
            lastRect: imgBox,
            spot: { x: imgBox.left + imgBox.width * 0.5, y: imgBox.top + imgBox.height * 0.5 },
            blockTextRight: imgBox.left + imgBox.width,
            blockBottom: imgBox.top + imgBox.height,
            blockIsSingleLine: false,
          });
        }
        continue;
      }

      const blockEl = blockRefs.current.get(ann.blockId);
      if (!blockEl) continue;
      const fullText = blockEl.textContent ?? "";
      const span = resolveDisplaySpan(fullText, ann);
      if (!span) continue;

      const range = findRangeInElement(blockEl, span.start, span.end);
      if (!range) continue;
      const clientRects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
      if (!clientRects.length) continue;
      const rects: BoxRect[] = clientRects.map((r) => ({
        left: r.left - stageRect.left,
        top: r.top - stageRect.top,
        width: r.width,
        height: r.height,
      }));
      const bounds = unionRects(rects);
      const bg = blockGeom.get(ann.blockId);
      nextMeasured.push({
        annotation: ann,
        blockKind: blockKindById.get(ann.blockId) ?? "paragraph",
        rects,
        bounds,
        firstRect: rects[0],
        lastRect: rects[rects.length - 1],
        blockTextRight: bg?.textRight ?? bounds.left + bounds.width,
        blockBottom: bg?.bottom ?? bounds.top + bounds.height,
        blockIsSingleLine: bg?.singleLine ?? false,
      });
    }

    const heights: Record<string, number> = {};
    const boxes: Record<string, BoxRect> = {};
    for (const [id, el] of noteRefs.current.entries()) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        heights[id] = r.height;
        boxes[id] = {
          left: r.left - stageRect.left,
          top: r.top - stageRect.top,
          width: r.width,
          height: r.height,
        };
      }
    }

    setPaperSpan({ left: pLeft, width: pWidth });
    setMeasured(nextMeasured);
    setNoteHeights(heights);
    setNoteBoxes(boxes);
  }, [page.annotations, blockKindById]);

  useLayoutEffect(() => {
    recomputeGeometry();
    // Run one settled animation frame after under-block flow & font metrics lay out.
    const raf = requestAnimationFrame(() => recomputeGeometry());
    return () => cancelAnimationFrame(raf);
  }, [recomputeGeometry, page.id, showInk, readingFont, translationMode, page.interactiveBlocks?.length]);

  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.kind === "block") {
      const el = blockRefs.current.get(focusRequest.id);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      setActiveId(focusRequest.id);
      const ann = page.annotations.find((a) => a.id === focusRequest.id);
      const targetEl =
        noteRefs.current.get(focusRequest.id) ??
        (ann ? blockRefs.current.get(ann.blockId) : undefined);
      targetEl?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusRequest, page.annotations]);

  useEffect(() => {
    const stageEl = stageRef.current;
    const paperEl = paperRef.current;
    if (!stageEl || !paperEl) return;
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => recomputeGeometry());
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(stageEl);
    ro.observe(paperEl);
    window.addEventListener("resize", schedule);
    let cancelled = false;
    document.fonts?.ready?.then(() => {
      if (!cancelled) schedule();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [recomputeGeometry]);

  // Collision-free placement:
  // 1) inline-blank: ONLY beside verified single-line headings/list items whose full text ends >=215px before paperRight
  // 2) under-block: in-flow directly below the block when the quote lies near the bottom of that block (no arrow crossing prose)
  // 3) left-margin / right-margin: dedicated outer margin lanes completely separate from the prose column
  const placementMap = useMemo(() => {
    const result = new Map<string, PlacedNoteMeta>();
    if (!isDesktopRail || !showInk) return result;

    const paperRight = paperSpan.left + paperSpan.width;
    const inlineOccupiedBands: Array<{ top: number; bottom: number }> = [];
    const underBlockUsed = new Set<string>();
    const leftSlots: Array<{ id: string; desiredTop: number; height: number }> = [];
    const rightSlots: Array<{ id: string; desiredTop: number; height: number }> = [];

    const ordered = [...measured].sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);

    for (const m of ordered) {
      const id = m.annotation.id;
      const noteH = noteHeights[id] ?? 68;
      if (m.blockKind === "image") {
        const spotX = m.spot?.x ?? m.bounds.left + m.bounds.width * 0.5;
        const desiredY = Math.max(4, (m.spot?.y ?? m.bounds.top) - 14);
        if (spotX < paperSpan.left + paperSpan.width * 0.5) {
          leftSlots.push({ id, desiredTop: desiredY, height: noteH });
        } else {
          rightSlots.push({ id, desiredTop: desiredY, height: noteH });
        }
        continue;
      }
      const isShortHeadingOrItem = m.blockKind === "heading" || m.blockKind === "list";
      const rightGapAfterBlock = paperRight - m.blockTextRight;

      if (isShortHeadingOrItem && m.blockIsSingleLine && rightGapAfterBlock >= 215 && noteH <= 58 && !m.annotation.sketch) {
        const candTop = Math.max(4, m.bounds.top - 4);
        const candBottom = candTop + noteH;
        const collides = inlineOccupiedBands.some((b) => candTop < b.bottom + 10 && candBottom > b.top - 10);
        if (!collides && candBottom <= m.blockBottom + 18) {
          const noteLeft = m.blockTextRight + 26;
          const availW = Math.max(170, paperRight - noteLeft);
          inlineOccupiedBands.push({ top: candTop, bottom: candBottom });
          result.set(id, {
            mode: "inline-blank",
            top: candTop,
            left: noteLeft,
            maxWidth: availW,
          });
          continue;
        }
      }

      const quoteBottom = m.lastRect.top + m.lastRect.height;
      const nearBottomOfBlock = m.blockBottom - quoteBottom <= 24;
      if (m.annotation.sketch) {
        // Notes carrying hand-drawn diagrams live spaciously under their paragraph so they are large, legible, and never overlap text.
        const relOffset = clamp(m.bounds.left - paperSpan.left, 0, Math.max(0, paperSpan.width - 480));
        result.set(id, {
          mode: "under-block",
          top: m.bounds.top,
          left: relOffset,
        });
        continue;
      }
      if (
        !underBlockUsed.has(m.annotation.blockId) &&
        m.annotation.style !== "bracket" &&
        (nearBottomOfBlock || m.blockIsSingleLine)
      ) {
        underBlockUsed.add(m.annotation.blockId);
        const relOffset = clamp(m.bounds.left - paperSpan.left, 0, Math.max(0, paperSpan.width - 320));
        result.set(id, {
          mode: "under-block",
          top: m.bounds.top,
          left: relOffset,
        });
        continue;
      }

      // Route to whichever side margin the annotated span actually borders closest (prevents arrows crossing prose)
      const leftmostRect = m.rects.reduce((a, b) => (a.left < b.left ? a : b));
      const rightmostRect = m.rects.reduce((a, b) => (a.left + a.width > b.left + b.width ? a : b));
      const leftEdgeDist = leftmostRect.left - paperSpan.left;
      const rightEdgeDist = paperRight - (rightmostRect.left + rightmostRect.width);
      if (leftEdgeDist <= rightEdgeDist && m.annotation.style !== "bracket") {
        leftSlots.push({ id, desiredTop: Math.max(4, leftmostRect.top - 6), height: noteH });
      } else {
        rightSlots.push({ id, desiredTop: Math.max(4, rightmostRect.top - 6), height: noteH });
      }
    }

    for (const pos of layoutMarginNotes(leftSlots, 16)) {
      result.set(pos.id, { mode: "left-margin", top: pos.top });
    }
    for (const pos of layoutMarginNotes(rightSlots, 16)) {
      result.set(pos.id, { mode: "right-margin", top: pos.top });
    }
    return result;
  }, [measured, isDesktopRail, showInk, paperSpan, noteHeights]);

  const railMinHeight = useMemo(() => {
    let maxBottom = 0;
    for (const m of measured) {
      const p = placementMap.get(m.annotation.id);
      if (!p || p.mode === "under-block") continue;
      const h = noteHeights[m.annotation.id] ?? 76;
      maxBottom = Math.max(maxBottom, p.top + h + 24);
    }
    return maxBottom;
  }, [measured, placementMap, noteHeights]);

  useEffect(() => {
    if (!selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelection(null);
        resetManualDraft(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection]);

  const handleImageClick = (e: MouseEvent<HTMLImageElement>, block: ReaderBlock) => {
    e.stopPropagation();
    if (!stageRef.current) return;
    const imgRect = e.currentTarget.getBoundingClientRect();
    if (imgRect.width < 12 || imgRect.height < 12) return;
    const stageRect = stageRef.current.getBoundingClientRect();
    const anchorX = Number(clamp((e.clientX - imgRect.left) / imgRect.width, 0.03, 0.97).toFixed(4));
    const anchorY = Number(clamp((e.clientY - imgRect.top) / imgRect.height, 0.04, 0.96).toFixed(4));
    const spotX = imgRect.left - stageRect.left + anchorX * imgRect.width;
    const spotY = imgRect.top - stageRect.top + anchorY * imgRect.height;

    window.getSelection()?.removeAllRanges();
    resetManualDraft(true);
    setSelection({
      blockId: block.id,
      quote: block.alt || "圖片註記",
      isImage: true,
      anchorX,
      anchorY,
      spotX,
      spotY,
      top: clamp(spotY - 82, 8, Math.max(8, stageRect.height - 110)),
      left: clamp(spotX - 160, 8, Math.max(8, stageRect.width - 360)),
    });
  };

  const handleMouseUp = () => {
    if (isTranslatedView) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      if (!manualOpen && !selectionInteractiveOpen) setSelection(null);
      return;
    }
    const quote = sel.toString().trim();
    if (quote.length < 2 || quote.length > 240) return;

    const range = sel.getRangeAt(0);
    let node: Node | null = range.commonAncestorContainer;
    while (node && !(node instanceof HTMLElement && node.dataset.blockText)) {
      node = node.parentNode;
    }
    if (!(node instanceof HTMLElement) || !node.dataset.blockText || !stageRef.current) return;

    const stageRect = stageRef.current.getBoundingClientRect();
    const selRect = range.getBoundingClientRect();
    resetManualDraft(false);
    setSelectionInteractiveOpen(false);
    setSelectionInteractivePrompt("");
    setSelection({
      blockId: node.dataset.blockText,
      quote,
      top: Math.max(8, selRect.top - stageRect.top - 50),
      left: clamp(selRect.left - stageRect.left, 8, Math.max(8, stageRect.width - 360)),
    });
  };

  const renderBlockElement = (block: ReaderBlock, idx: number) => {
    const blockAnns = annotationsByBlock.get(block.id) ?? [];
    const setRef = (el: HTMLElement | null) => {
      if (el) blockRefs.current.set(block.id, el);
      else blockRefs.current.delete(block.id);
    };
    const content = renderInteractiveText(block.text, blockAnns, activeId, setActiveId, showInk);

    let element: ReactNode;
    if (block.kind === "heading") {
      const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
      element = (
        <Tag ref={setRef} data-block-text={block.id} className={`reader-heading level-${block.level ?? 2}`}>
          {content}
        </Tag>
      );
    } else if (block.kind === "code") {
      element = (
        <pre className="reader-code-wrap">
          {block.language ? <span className="reader-code-lang">{block.language}</span> : null}
          <code ref={setRef} data-block-text={block.id} className="reader-code">
            {content}
          </code>
        </pre>
      );
    } else if (block.kind === "quote") {
      element = (
        <blockquote ref={setRef} data-block-text={block.id} className="reader-quote">
          {content}
        </blockquote>
      );
    } else if (block.kind === "list") {
      element = (
        <div className="reader-list-item">
          <span className="reader-bullet" aria-hidden="true" />
          <div ref={setRef} data-block-text={block.id} className="reader-list-text">
            {content}
          </div>
        </div>
      );
    } else if (block.kind === "table") {
      const rows = block.tableRows?.length
        ? block.tableRows
        : block.text
            .split("\n")
            .map((r) => r.split(" | ").map((c) => c.trim()))
            .filter((r) => r.some(Boolean));
      let offset = 0;
      const cellNodes = rows.map((row, rIdx) => {
        const rowNodes = row.map((cell, cIdx) => {
          const start = offset;
          const end = start + cell.length;
          offset = end + (cIdx < row.length - 1 ? 3 : 0);
          const cellAnns = blockAnns
            .filter((a) => a.startOffset < end && a.endOffset > start)
            .map((a) => ({
              ...a,
              startOffset: Math.max(0, a.startOffset - start),
              endOffset: Math.min(cell.length, a.endOffset - start),
            }));
          const rendered = renderInteractiveText(cell, cellAnns, activeId, setActiveId, showInk);
          return rIdx === 0 ? <th key={cIdx}>{rendered}</th> : <td key={cIdx}>{rendered}</td>;
        });
        offset += rIdx < rows.length - 1 ? 1 : 0;
        return <tr key={rIdx}>{rowNodes}</tr>;
      });
      element = (
        <div className="reader-table-wrap">
          <table ref={setRef} data-block-text={block.id} className="reader-table">
            {cellNodes.length > 0 ? <thead>{cellNodes[0]}</thead> : null}
            {cellNodes.length > 1 ? <tbody>{cellNodes.slice(1)}</tbody> : null}
          </table>
        </div>
      );
    } else if (block.kind === "image" && block.imageUrl) {
      const pinnedAnns = showInk ? blockAnns.filter((a) => a.anchorX !== undefined && a.anchorY !== undefined) : [];
      element = (
        <figure ref={setRef} data-block-text={block.id} className="reader-figure">
          <div className="reader-figure-frame">
            <img
              ref={(el) => {
                if (el) imageRefs.current.set(block.id, el);
                else imageRefs.current.delete(block.id);
              }}
              src={block.imageUrl}
              alt={block.alt || ""}
              decoding="async"
              referrerPolicy="no-referrer"
              onLoad={() => recomputeGeometry()}
              onClick={(e) => handleImageClick(e, block)}
              title="點擊圖形任意位置即可用原子筆圈註並拉出箭頭筆記"
            />
            {pinnedAnns.map((ann) => (
              <button
                key={ann.id}
                type="button"
                className={`figure-pin-hit ${activeId === ann.id ? "is-active" : ""}`}
                style={{
                  left: `${clamp(ann.anchorX!, 0.03, 0.97) * 100}%`,
                  top: `${clamp(ann.anchorY!, 0.04, 0.96) * 100}%`,
                }}
                aria-label={`查看圖形註解：${ann.label || "圖形註記"} — ${ann.note}`}
                onMouseEnter={() => setActiveId(ann.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveId(ann.id);
                }}
              />
            ))}
            <span className="figure-annotate-hint" aria-hidden="true">
              <PenLine size={11} />
              <span>點圖任一點下筆記</span>
            </span>
          </div>
          {block.alt ? <figcaption>{block.alt}</figcaption> : null}
        </figure>
      );
    } else {
      element = (
        <p ref={setRef} data-block-text={block.id} className="reader-paragraph">
          {content}
        </p>
      );
    }

    const trBlock = isBilingualView
      ? translatedBlocks?.find((b) => b.id === block.id) ?? translatedBlocks?.[idx]
      : undefined;

    const renderedContent = isBilingualView ? (
      <div className="bilingual-block-pair">
        <div className="bilingual-orig-col">{element}</div>
        <div className="bilingual-tr-col" aria-label="繁體中文譯文">
          {trBlock ? renderPlainTranslatedBlock(trBlock) : <p className="reader-paragraph is-muted">—</p>}
        </div>
      </div>
    ) : (
      element
    );

    const underNotes = isDesktopRail && showInk
      ? blockAnns.filter((ann) => placementMap.get(ann.id)?.mode === "under-block")
      : [];
    const attachedInteractive = interactiveByAfterBlock.get(block.id) ?? [];
    const pickerOpen = blockPickerId === block.id;

    return (
      <div key={block.id} className="reader-block-row" data-block-row={block.id}>
        {renderedContent}
        {block.kind !== "image" ? (
          <div className={`block-interactive-strip ${pickerOpen ? "is-open" : ""}`}>
            <button
              type="button"
              className="block-interactive-trigger"
              disabled={interactiveBusy}
              onClick={() => setBlockPickerId((cur) => (cur === block.id ? null : block.id))}
            >
              <Plus size={11} aria-hidden="true" />
              <span>互動區塊</span>
            </button>
            {pickerOpen ? (
              <div className="block-interactive-choices" role="group" aria-label="選擇互動類型">
                <button
                  type="button"
                  className="block-choice-btn"
                  disabled={interactiveBusy}
                  onClick={async () => {
                    setBlockPickerId(null);
                    await onCreateInteractiveBlock({
                      afterBlockId: block.id,
                      quote: block.text.slice(0, 140),
                      kind: "simulation",
                    });
                  }}
                >
                  <Cpu size={11} aria-hidden="true" />
                  <span>互動模擬</span>
                </button>
                <button
                  type="button"
                  className="block-choice-btn"
                  disabled={interactiveBusy}
                  onClick={async () => {
                    setBlockPickerId(null);
                    await onCreateInteractiveBlock({
                      afterBlockId: block.id,
                      quote: block.text.slice(0, 140),
                      kind: "stepper",
                    });
                  }}
                >
                  <ListChecks size={11} aria-hidden="true" />
                  <span>概念步進</span>
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {underNotes.length > 0 ? (
          <div className="near-notes-row">
            {underNotes.map((ann) => {
              const meta = placementMap.get(ann.id);
              return (
                <div
                  key={ann.id}
                  className="under-note-slot"
                  style={meta?.left ? { paddingLeft: `${meta.left}px` } : undefined}
                >
                  <PenNote
                    annotation={ann}
                    active={activeId === ann.id}
                    mode="under-block"
                    explainOrigin={explainOrigin}
                    pageId={page.id}
                    pageTitle={page.title}
                    onActivate={() => setActiveId(ann.id)}
                    onUpdate={onUpdateAnnotation}
                    onDelete={onDeleteAnnotation}
                    noteRef={(el) => {
                      if (el) noteRefs.current.set(ann.id, el);
                      else noteRefs.current.delete(ann.id);
                    }}
                  />
                </div>
              );
            })}
          </div>
        ) : null}
        {!isDesktopRail && showInk && blockAnns.length > 0 ? (
          <div className="mobile-margin-stack">
            {blockAnns.map((ann) => (
              <PenNote
                key={ann.id}
                annotation={ann}
                active={activeId === ann.id}
                mode="compact"
                explainOrigin={explainOrigin}
                pageId={page.id}
                pageTitle={page.title}
                onActivate={() => setActiveId(ann.id)}
                onUpdate={onUpdateAnnotation}
                onDelete={onDeleteAnnotation}
              />
            ))}
          </div>
        ) : null}
        {attachedInteractive.length > 0 ? (
          <div className="block-interactive-stack">
            {attachedInteractive.map((ib) => (
              <InteractiveBlockCard
                key={ib.id}
                block={ib}
                pageId={page.id}
                theme={theme}
                upgrading={upgradingBlockId === ib.id}
                onUpdateState={onUpdateInteractiveState}
                onUpgrade={onUpgradeInteractiveBlock}
                onDelete={onDeleteInteractiveBlock}
                onGeometryChange={recomputeGeometry}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  const inlineNotes = useMemo(
    () => (isDesktopRail && showInk ? measured.filter((m) => placementMap.get(m.annotation.id)?.mode === "inline-blank") : []),
    [isDesktopRail, showInk, measured, placementMap],
  );

  const leftMarginNotes = useMemo(
    () => (isDesktopRail && showInk ? measured.filter((m) => placementMap.get(m.annotation.id)?.mode === "left-margin") : []),
    [isDesktopRail, showInk, measured, placementMap],
  );

  const rightMarginNotes = useMemo(
    () => (isDesktopRail && showInk ? measured.filter((m) => placementMap.get(m.annotation.id)?.mode === "right-margin") : []),
    [isDesktopRail, showInk, measured, placementMap],
  );

  return (
    <div
      ref={stageRef}
      className={`ink-stage ${isDesktopRail ? "has-margins" : "is-compact"}`}
      onMouseUp={handleMouseUp}
    >
      {showInk ? (
        <svg
          className="ink-overlay-svg"
          aria-hidden="true"
        >
          {measured.filter((m) => m.blockKind !== "image").map((m) => {
            const { annotation, rects, bounds } = m;
            const isActive = activeId === annotation.id;
            const meta = placementMap.get(annotation.id);
            const box = noteBoxes[annotation.id];
            const colorVar = `var(--ink-${annotation.color}-stroke)`;
            const washVar = `var(--ink-${annotation.color}-wash)`;
            const arrowPts = isDesktopRail && meta && box ? arrowEndpoints(m, meta.mode, box) : null;

            return (
              <g key={annotation.id} className={`ink-stroke-group ${isActive ? "is-active" : ""}`}>
                {annotation.style === "highlight" &&
                  rects.map((rect, idx) => (
                    <path
                      key={idx}
                      d={highlighterPath(rect, `${annotation.id}:${idx}`)}
                      fill={washVar}
                      opacity={isActive ? 1 : 0.9}
                      className="ink-highlighter-path"
                    />
                  ))}
                {annotation.style === "underline" &&
                  rects.map((rect, idx) => (
                    <path
                      key={idx}
                      d={wavyUnderlinePath(rect, `${annotation.id}:${idx}`)}
                      fill="none"
                      stroke={colorVar}
                      strokeWidth={isActive ? 1.85 : 1.35}
                      strokeLinecap="round"
                    />
                  ))}
                {annotation.style === "box" &&
                  rects.map((rect, idx) => (
                    <path
                      key={idx}
                      d={handBoxPath(rect, `${annotation.id}:${idx}`)}
                      fill="none"
                      stroke={colorVar}
                      strokeWidth={isActive ? 1.8 : 1.3}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ))}
                {annotation.style === "bracket" && (
                  <path
                    d={bracketPath(bounds, annotation.id)}
                    fill="none"
                    stroke={colorVar}
                    strokeWidth={isActive ? 1.9 : 1.4}
                    strokeLinecap="round"
                  />
                )}
                {arrowPts ? (
                  <path
                    d={leaderArrowPath(arrowPts.ax, arrowPts.ay, arrowPts.nx, arrowPts.ny, annotation.id)}
                    fill="none"
                    stroke={colorVar}
                    strokeWidth={isActive ? 1.45 : 1.05}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={isActive ? 0.96 : 0.62}
                  />
                ) : null}
              </g>
            );
          })}
        </svg>
      ) : null}

      {showInk || selection?.isImage ? (
        <svg
          className="ink-image-overlay-svg"
          aria-hidden="true"
        >
          {showInk
            ? measured
                .filter((m) => m.blockKind === "image")
                .map((m) => {
                  const { annotation, bounds, spot } = m;
                  const isActive = activeId === annotation.id;
                  const meta = placementMap.get(annotation.id);
                  const box = noteBoxes[annotation.id];
                  const colorVar = `var(--ink-${annotation.color}-stroke)`;
                  const arrowPts = isDesktopRail && meta && box ? arrowEndpoints(m, meta.mode, box) : null;
                  const pinPath =
                    spot && annotation.anchorX !== undefined
                      ? handPinCirclePath(spot.x, spot.y, 13, annotation.id)
                      : handBoxPath(bounds, annotation.id);
                  const arrowPath = arrowPts
                    ? leaderArrowPath(arrowPts.ax, arrowPts.ay, arrowPts.nx, arrowPts.ny, annotation.id)
                    : null;

                  return (
                    <g key={annotation.id} className={`ink-stroke-group ${isActive ? "is-active" : ""}`}>
                      {spot && annotation.anchorX !== undefined ? (
                        <>
                          <circle cx={spot.x} cy={spot.y} r={3.2} fill="var(--paper-sheet)" opacity={0.88} />
                          <circle cx={spot.x} cy={spot.y} r={2} fill={colorVar} />
                        </>
                      ) : null}
                      <path
                        d={pinPath}
                        fill="none"
                        stroke="var(--paper-sheet)"
                        strokeWidth={isActive ? 4.2 : 3.4}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={0.78}
                      />
                      <path
                        d={pinPath}
                        fill="none"
                        stroke={colorVar}
                        strokeWidth={isActive ? 2.0 : 1.55}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      {arrowPath ? (
                        <>
                          <path
                            d={arrowPath}
                            fill="none"
                            stroke="var(--paper-sheet)"
                            strokeWidth={isActive ? 3.2 : 2.6}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            opacity={0.78}
                          />
                          <path
                            d={arrowPath}
                            fill="none"
                            stroke={colorVar}
                            strokeWidth={isActive ? 1.55 : 1.2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            opacity={isActive ? 0.98 : 0.78}
                          />
                        </>
                      ) : null}
                    </g>
                  );
                })
            : null}
          {selection?.isImage && selection.spotX !== undefined && selection.spotY !== undefined ? (
            <g>
              <circle cx={selection.spotX} cy={selection.spotY} r={3} fill={`var(--ink-${penColor}-stroke)`} />
              <path
                d={handPinCirclePath(selection.spotX, selection.spotY, 13, `preview-${selection.blockId}`)}
                fill="none"
                stroke="var(--paper-sheet)"
                strokeWidth={3.6}
                opacity={0.85}
              />
              <path
                d={handPinCirclePath(selection.spotX, selection.spotY, 13, `preview-${selection.blockId}`)}
                fill="none"
                stroke={`var(--ink-${penColor}-stroke)`}
                strokeWidth={1.7}
                strokeDasharray="3 2"
              />
            </g>
          ) : null}
        </svg>
      ) : null}

      {selection ? (
        <div
          className={`selection-pen-bar ${selection.isImage ? "is-image-mode" : ""}`}
          style={{ top: `${selection.top}px`, left: `${selection.left}px` }}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="pen-bar-row">
            {selection.isImage ? (
              <span className="pen-image-mode-title">
                <PenLine size={12} aria-hidden="true" />
                <span>圖形原子筆筆記</span>
              </span>
            ) : (
              <div className="pen-styles" role="group" aria-label="筆觸樣式">
                {(
                  [
                    ["highlight", Highlighter],
                    ["underline", Underline],
                    ["box", Circle],
                    ["bracket", Braces],
                  ] as const
                ).map(([style, Icon]) => (
                  <button
                    key={style}
                    type="button"
                    className={`pen-icon-btn ${penStyle === style ? "is-selected" : ""}`}
                    title={STYLE_LABELS[style]}
                    aria-label={STYLE_LABELS[style]}
                    aria-pressed={penStyle === style}
                    onClick={() => setPenStyle(style)}
                  >
                    <Icon size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
            <div className="pen-colors" role="group" aria-label="筆水顏色">
              {INK_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`pen-color-dot dot-${c} ${penColor === c ? "is-selected" : ""}`}
                  title={COLOR_NAMES[c]}
                  aria-label={COLOR_NAMES[c]}
                  aria-pressed={penColor === c}
                  onClick={() => setPenColor(c)}
                />
              ))}
            </div>
            {!selection.isImage ? (
              <>
                <button
                  type="button"
                  className="pen-action-btn is-primary"
                  disabled={selectionBusy}
                  onClick={async () => {
                    const target = selection;
                    setSelection(null);
                    window.getSelection()?.removeAllRanges();
                    await onAiSelection({
                      blockId: target.blockId,
                      quote: target.quote,
                      style: penStyle,
                      color: penColor,
                    });
                  }}
                >
                  <Sparkles size={13} aria-hidden="true" />
                  <span>{selectionBusy ? "標註中…" : "AI 說明"}</span>
                </button>
                <button
                  type="button"
                  className="pen-action-btn"
                  onClick={() => {
                    setSelectionInteractiveOpen(false);
                    setManualOpen((v) => !v);
                  }}
                >
                  <PenLine size={13} aria-hidden="true" />
                  <span>手寫批註</span>
                </button>
                <button
                  type="button"
                  className="pen-action-btn is-interactive"
                  disabled={interactiveBusy}
                  onClick={() => {
                    setManualOpen(false);
                    setSelectionInteractiveOpen((v) => !v);
                  }}
                >
                  <Plus size={13} aria-hidden="true" />
                  <span>互動區塊</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="pen-icon-btn pen-close-btn"
                aria-label="取消圖形筆記"
                onClick={() => {
                  setSelection(null);
                  resetManualDraft(false);
                }}
              >
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </div>
          {selectionInteractiveOpen && !selection.isImage ? (
            <div className="pen-interactive-chooser">
              <input
                type="text"
                className="pen-interactive-input"
                value={selectionInteractivePrompt}
                onChange={(e) => setSelectionInteractivePrompt(e.target.value)}
                placeholder="選填重點（例：比較延遲或步驟）…"
                aria-label="互動區塊聚焦提示"
                maxLength={120}
              />
              <div className="pen-interactive-btns">
                <button
                  type="button"
                  className="pen-action-btn is-primary"
                  disabled={interactiveBusy}
                  onClick={async () => {
                    const target = selection;
                    const prompt = selectionInteractivePrompt.trim();
                    setSelection(null);
                    setSelectionInteractiveOpen(false);
                    setSelectionInteractivePrompt("");
                    window.getSelection()?.removeAllRanges();
                    await onCreateInteractiveBlock({
                      afterBlockId: target.blockId,
                      quote: target.quote,
                      kind: "simulation",
                      ...(prompt ? { prompt } : {}),
                    });
                  }}
                >
                  <Cpu size={12} aria-hidden="true" />
                  <span>{interactiveBusy ? "建立中…" : "互動模擬"}</span>
                </button>
                <button
                  type="button"
                  className="pen-action-btn"
                  disabled={interactiveBusy}
                  onClick={async () => {
                    const target = selection;
                    const prompt = selectionInteractivePrompt.trim();
                    setSelection(null);
                    setSelectionInteractiveOpen(false);
                    setSelectionInteractivePrompt("");
                    window.getSelection()?.removeAllRanges();
                    await onCreateInteractiveBlock({
                      afterBlockId: target.blockId,
                      quote: target.quote,
                      kind: "stepper",
                      ...(prompt ? { prompt } : {}),
                    });
                  }}
                >
                  <ListChecks size={12} aria-hidden="true" />
                  <span>概念步進</span>
                </button>
              </div>
            </div>
          ) : null}
          {manualOpen ? (
            <form
              className="pen-manual-form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!manualNote.trim()) return;
                const target = selection;
                const text = manualNote.trim();
                const label = manualLabel.trim() || (target.isImage ? "圖形註記" : undefined);
                const sketchToSend = draftSketch;
                setSelection(null);
                resetManualDraft(false);
                window.getSelection()?.removeAllRanges();
                await onManualSelection({
                  blockId: target.blockId,
                  quote: target.quote,
                  style: target.isImage ? "box" : penStyle,
                  color: penColor,
                  ...(label ? { label } : {}),
                  note: text,
                  ...(target.isImage && target.anchorX !== undefined && target.anchorY !== undefined
                    ? { anchorX: target.anchorX, anchorY: target.anchorY }
                    : {}),
                  ...(sketchToSend ? { sketch: sketchToSend } : {}),
                });
              }}
            >
              <div className="pen-manual-row">
                {selection.isImage ? (
                  <input
                    type="text"
                    className="pen-label-input"
                    value={manualLabel}
                    onChange={(e) => setManualLabel(e.target.value)}
                    placeholder="標籤（如：重點）"
                    aria-label="圖形標籤"
                    maxLength={16}
                  />
                ) : null}
                <input
                  type="text"
                  value={manualNote}
                  onChange={(e) => setManualNote(e.target.value)}
                  placeholder={selection.isImage ? "寫下對這個圖形／結果的附註或注意事項…" : "寫下頁邊筆記…"}
                  aria-label="頁邊筆記內容"
                  maxLength={300}
                  autoFocus
                />
                <button type="submit" className="pen-action-btn is-primary">
                  儲存
                </button>
              </div>
              <div className="pen-sketch-composer">
                <div className="pen-sketch-kinds" role="group" aria-label="附帶手繪圖解">
                  <button
                    type="button"
                    className={`pen-sketch-chip ${manualSketchKind === "none" ? "is-selected" : ""}`}
                    onClick={() => setManualSketchKind("none")}
                  >
                    無圖解
                  </button>
                  {MANUAL_SKETCH_PRESETS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      className={`pen-sketch-chip ${manualSketchKind === k ? "is-selected" : ""}`}
                      onClick={() => setManualSketchKind(k)}
                    >
                      {SKETCH_KIND_LABELS[k]}
                    </button>
                  ))}
                </div>
                {manualSketchKind !== "none" ? (
                  <div className="pen-sketch-fields">
                    <input
                      type="text"
                      value={manualSketchNodes}
                      onChange={(e) => setManualSketchNodes(e.target.value)}
                      placeholder={
                        manualSketchKind === "axes"
                          ? "標籤用 -> 隔開（例：成本 -> 延遲 -> 甜蜜點）"
                          : manualSketchKind === "venn"
                            ? "集合用 -> 隔開（例：集合A -> 集合B -> 交集）"
                            : manualSketchKind === "tree"
                              ? "樹狀用 -> 隔開（例：總問題 -> 子因A -> 子因B）"
                              : "節點用 -> 隔開，2至5個（例：步驟1 -> 步驟2 -> 步驟3）"
                      }
                      aria-label="手繪圖解節點"
                    />
                    {manualSketchKind === "axes" ? (
                      <div className="pen-sketch-shapes" role="group" aria-label="曲線形狀">
                        {SKETCH_CURVE_SHAPES.map((s) => (
                          <button
                            key={s}
                            type="button"
                            className={`pen-sketch-chip ${manualSketchShape === s ? "is-selected" : ""}`}
                            onClick={() => setManualSketchShape(s)}
                          >
                            {SKETCH_SHAPE_LABELS[s]}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {draftSketch ? (
                      <div className="pen-sketch-preview">
                        <HandSketch sketch={draftSketch} color={penColor} seed="draft-preview" compact />
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </form>
          ) : null}
        </div>
      ) : null}

      {isDesktopRail ? (
        <div
          className="margin-lane margin-lane-left"
          style={{ minHeight: `${Math.max(200, railMinHeight)}px` }}
        >
          {leftMarginNotes.map((m) => (
            <PenNote
              key={m.annotation.id}
              annotation={m.annotation}
              active={activeId === m.annotation.id}
              mode="left-margin"
              explainOrigin={explainOrigin}
              pageId={page.id}
              pageTitle={page.title}
              onActivate={() => setActiveId(m.annotation.id)}
              onUpdate={onUpdateAnnotation}
              onDelete={onDeleteAnnotation}
              stylePos={{ top: placementMap.get(m.annotation.id)?.top ?? m.bounds.top }}
              noteRef={(el) => {
                if (el) noteRefs.current.set(m.annotation.id, el);
                else noteRefs.current.delete(m.annotation.id);
              }}
            />
          ))}
        </div>
      ) : null}

      <article ref={paperRef} className={`reader-paper ${readingFont === "serif" ? "is-serif" : ""}`}>
        {page.summary ? (
          <div className="reader-ai-summary">
            <span className="summary-scribble-tag">摘要筆記</span>
            <p>
              <bdi>{page.summary}</bdi>
            </p>
          </div>
        ) : null}
        {(interactiveByAfterBlock.get("__top__") ?? []).map((ib) => (
          <InteractiveBlockCard
            key={ib.id}
            block={ib}
            pageId={page.id}
            theme={theme}
            upgrading={upgradingBlockId === ib.id}
            onUpdateState={onUpdateInteractiveState}
            onUpgrade={onUpgradeInteractiveBlock}
            onDelete={onDeleteInteractiveBlock}
            onGeometryChange={recomputeGeometry}
          />
        ))}
        {page.blocks.map((block, idx) => renderBlockElement(block, idx))}
      </article>

      {isDesktopRail ? (
        <div
          className="margin-lane margin-lane-right"
          style={{ minHeight: `${Math.max(200, railMinHeight)}px` }}
        >
          {showInk && measured.length === 0 ? (
            <p className="margin-lane-hint">
              點擊上方「AI 塗鴉標註」畫重點，或反白任意詞句寫下筆記／互動區塊。
            </p>
          ) : null}
          {rightMarginNotes.map((m) => (
            <PenNote
              key={m.annotation.id}
              annotation={m.annotation}
              active={activeId === m.annotation.id}
              mode="right-margin"
              explainOrigin={explainOrigin}
              pageId={page.id}
              pageTitle={page.title}
              onActivate={() => setActiveId(m.annotation.id)}
              onUpdate={onUpdateAnnotation}
              onDelete={onDeleteAnnotation}
              stylePos={{ top: placementMap.get(m.annotation.id)?.top ?? m.bounds.top }}
              noteRef={(el) => {
                if (el) noteRefs.current.set(m.annotation.id, el);
                else noteRefs.current.delete(m.annotation.id);
              }}
            />
          ))}
        </div>
      ) : null}

      {isDesktopRail && inlineNotes.length > 0 ? (
        <div className="inline-notes-layer">
          {inlineNotes.map((m) => {
            const meta = placementMap.get(m.annotation.id);
            return (
              <PenNote
                key={m.annotation.id}
                annotation={m.annotation}
                active={activeId === m.annotation.id}
                mode="inline-blank"
                explainOrigin={explainOrigin}
                pageId={page.id}
                pageTitle={page.title}
                onActivate={() => setActiveId(m.annotation.id)}
                onUpdate={onUpdateAnnotation}
                onDelete={onDeleteAnnotation}
                stylePos={
                  meta
                    ? {
                        top: meta.top,
                        left: meta.left,
                        maxWidth: meta.maxWidth,
                      }
                    : undefined
                }
                noteRef={(el) => {
                  if (el) noteRefs.current.set(m.annotation.id, el);
                  else noteRefs.current.delete(m.annotation.id);
                }}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
