import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AudioLines, Braces, Circle, Highlighter, PenLine, Sparkles, Trash2, Underline } from "lucide-react";
import {
  INK_COLORS,
  type InkColor,
  type InkStyle,
  type PageAnnotation,
  type ReaderBlock,
  type SavedPage,
} from "../../shared/types";
import { explainDraftHref } from "../../shared/suite";
import {
  bracketPath,
  handBoxPath,
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
  lastRect: BoxRect;
  firstRect: BoxRect;
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

function renderInteractiveText(
  text: string,
  annotations: PageAnnotation[],
  activeId: string | null,
  onSelectAnnotation: (id: string) => void,
  showInk: boolean,
): ReactNode {
  if (!showInk || !annotations.length) return text;
  const sorted = [...annotations]
    .filter((a) => a.startOffset >= 0 && a.endOffset > a.startOffset && a.endOffset <= text.length)
    .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);

  const pieces: ReactNode[] = [];
  let cursor = 0;
  for (const ann of sorted) {
    if (ann.startOffset < cursor) continue;
    if (ann.startOffset > cursor) {
      pieces.push(text.slice(cursor, ann.startOffset));
    }
    const slice = text.slice(ann.startOffset, ann.endOffset);
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
    cursor = ann.endOffset;
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
  onDelete: (id: string) => void;
  stylePos?: { top?: number; left?: number; maxWidth?: number };
  noteRef?: (el: HTMLElement | null) => void;
}) {
  const explainHref = useMemo(
    () =>
      explainDraftHref(
        explainOrigin,
        {
          title: annotation.topic ? `${pageTitle} · ${annotation.topic}` : pageTitle,
          text: `原文摘錄：\n「${annotation.quote}」\n\n頁邊筆記：\n${annotation.note}`,
          back: `#/page/${pageId}`,
        },
        typeof window !== "undefined" ? window.location.hostname : "",
      ),
    [annotation, explainOrigin, pageId, pageTitle],
  );

  return (
    <aside
      ref={noteRef}
      className={`pen-note pen-ink-${annotation.color} is-${mode} ${active ? "is-active" : ""}`}
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
      <p className="pen-note-body">
        <bdi>{annotation.note}</bdi>
      </p>
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
): { ax: number; ay: number; nx: number; ny: number } {
  const { bounds, firstRect, lastRect, annotation } = anchor;

  if (mode === "inline-blank") {
    return {
      ax: lastRect.left + lastRect.width + 4,
      ay: lastRect.top + lastRect.height * 0.58,
      nx: noteBox.left - 5,
      ny: clamp(lastRect.top + lastRect.height * 0.5, noteBox.top + 8, noteBox.top + 22),
    };
  }

  if (mode === "under-block") {
    const startX = clamp(bounds.left + Math.min(bounds.width * 0.35, 36), bounds.left + 8, bounds.left + bounds.width - 6);
    const startY = lastRect.top + lastRect.height + 2;
    const endX = clamp(startX + 10, noteBox.left + 12, noteBox.left + noteBox.width - 16);
    const endY = noteBox.top - 4;
    return { ax: startX, ay: startY, nx: endX, ny: endY };
  }

  if (mode === "left-margin") {
    return {
      ax: firstRect.left - 4,
      ay: firstRect.top + firstRect.height * 0.55,
      nx: noteBox.left + noteBox.width + 6,
      ny: noteBox.top + Math.min(18, noteBox.height * 0.4),
    };
  }

  // right-margin
  const startX = annotation.style === "bracket" ? bounds.left + bounds.width + 12 : lastRect.left + lastRect.width + 5;
  const startY = annotation.style === "bracket" ? bounds.top + bounds.height * 0.5 : lastRect.top + lastRect.height * 0.55;
  return {
    ax: startX,
    ay: startY,
    nx: noteBox.left - 6,
    ny: noteBox.top + Math.min(18, noteBox.height * 0.4),
  };
}

export default function InkStage({
  page,
  showInk,
  readingFont,
  explainOrigin,
  selectionBusy,
  onAiSelection,
  onManualSelection,
  onDeleteAnnotation,
}: {
  page: SavedPage;
  showInk: boolean;
  readingFont: "sans" | "serif";
  explainOrigin?: string;
  selectionBusy: boolean;
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
    note: string;
  }) => Promise<void>;
  onDeleteAnnotation: (annotationId: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const paperRef = useRef<HTMLElement | null>(null);
  const leftLaneRef = useRef<HTMLDivElement | null>(null);
  const rightLaneRef = useRef<HTMLDivElement | null>(null);
  const blockRefs = useRef<Map<string, HTMLElement>>(new Map());
  const noteRefs = useRef<Map<string, HTMLElement>>(new Map());
  const measureSigRef = useRef<string>("");

  const [activeId, setActiveId] = useState<string | null>(null);
  const [isDesktopRail, setIsDesktopRail] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth >= 1060 : true,
  );
  const [measured, setMeasured] = useState<MeasuredAnchor[]>([]);
  const [paperSpan, setPaperSpan] = useState<{ left: number; width: number }>({ left: 210, width: 620 });
  const [noteHeights, setNoteHeights] = useState<Record<string, number>>({});
  const [noteBoxes, setNoteBoxes] = useState<Record<string, BoxRect>>({});
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>({ width: 1060, height: 600 });

  const [selection, setSelection] = useState<PendingSelection | null>(null);
  const [penStyle, setPenStyle] = useState<InkStyle>("highlight");
  const [penColor, setPenColor] = useState<InkColor>("sky");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualNote, setManualNote] = useState("");

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

    const desktop = window.innerWidth >= 1060;
    setIsDesktopRail(desktop);

    const stageRect = stageEl.getBoundingClientRect();
    const paperRect = paperEl.getBoundingClientRect();
    const pLeft = paperRect.left - stageRect.left;
    const pWidth = paperRect.width;

    const nextMeasured: MeasuredAnchor[] = [];
    for (const ann of page.annotations) {
      const blockEl = blockRefs.current.get(ann.blockId);
      if (!blockEl) continue;
      const fullText = blockEl.textContent ?? "";
      let start = ann.startOffset;
      let end = ann.endOffset;
      if (start < 0 || end > fullText.length || fullText.slice(start, end) !== ann.quote) {
        const idx = fullText.indexOf(ann.quote);
        if (idx >= 0) {
          start = idx;
          end = idx + ann.quote.length;
        } else {
          continue;
        }
      }
      const range = findRangeInElement(blockEl, start, end);
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
      nextMeasured.push({
        annotation: ann,
        blockKind: blockKindById.get(ann.blockId) ?? "paragraph",
        rects,
        bounds,
        firstRect: rects[0],
        lastRect: rects[rects.length - 1],
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

    const nextWidth = Math.max(stageEl.scrollWidth, stageRect.width);
    const nextHeight = Math.max(stageEl.scrollHeight, stageRect.height);
    const sig = `${desktop}|${Math.round(pLeft)}|${Math.round(pWidth)}|${Math.round(nextWidth)}|${Math.round(nextHeight)}|${nextMeasured.length}|${Object.keys(boxes).length}|${Object.values(boxes).map((b) => `${Math.round(b.left)},${Math.round(b.top)}`).join(";")}`;

    setPaperSpan({ left: pLeft, width: pWidth });
    setMeasured(nextMeasured);
    setNoteHeights(heights);
    setNoteBoxes(boxes);
    setStageSize({ width: nextWidth, height: nextHeight });
    measureSigRef.current = sig;
  }, [page.annotations, blockKindById]);

  useLayoutEffect(() => {
    recomputeGeometry();
    // Run one settled animation frame after under-block flow & font metrics lay out.
    const raf = requestAnimationFrame(() => recomputeGeometry());
    return () => cancelAnimationFrame(raf);
  }, [recomputeGeometry, page.id, showInk, readingFont]);

  useEffect(() => {
    const paperEl = paperRef.current;
    if (!paperEl) return;
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => recomputeGeometry());
    };
    const ro = new ResizeObserver(schedule);
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

  // Decide placement for each measured annotation:
  // 1) inline-blank: short lines/headings with >= 180px free whitespace to the right inside the paper column
  // 2) under-block: first eligible annotation of a block sits in-flow right below that block near the highlighted quote
  // 3) left-margin / right-margin: remaining annotations hug close to whichever side the marked text leans toward
  const placementMap = useMemo(() => {
    const result = new Map<string, PlacedNoteMeta>();
    if (!isDesktopRail || !showInk) return result;

    const paperRight = paperSpan.left + paperSpan.width;
    const paperMid = paperSpan.left + paperSpan.width * 0.46;
    const inlineOccupiedBands: Array<{ top: number; bottom: number }> = [];
    const underBlockUsed = new Set<string>();
    const leftSlots: Array<{ id: string; desiredTop: number; height: number }> = [];
    const rightSlots: Array<{ id: string; desiredTop: number; height: number }> = [];

    const ordered = [...measured].sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);

    for (const m of ordered) {
      const id = m.annotation.id;
      const noteH = noteHeights[id] ?? 68;
      const rightGap = paperRight - (m.lastRect.left + m.lastRect.width);
      const isShortBlock = m.blockKind === "heading" || m.blockKind === "list";

      // Check inline blank space inside the paper column (beside headings, list items, or short ending lines)
      if ((isShortBlock && rightGap >= 165) || rightGap >= 205) {
        const candTop = Math.max(4, m.lastRect.top - 4);
        const candBottom = candTop + noteH;
        const collides = inlineOccupiedBands.some((b) => candTop < b.bottom + 8 && candBottom > b.top - 8);
        if (!collides) {
          const noteLeft = m.lastRect.left + m.lastRect.width + 24;
          const availW = Math.max(150, paperRight - noteLeft);
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

      // First non-inline annotation for a paragraph/quote/code block sits close underneath that block
      if (!underBlockUsed.has(m.annotation.blockId) && m.annotation.style !== "bracket") {
        underBlockUsed.add(m.annotation.blockId);
        const relOffset = clamp(m.bounds.left - paperSpan.left - 8, 0, Math.max(0, paperSpan.width - 280));
        result.set(id, {
          mode: "under-block",
          top: m.bounds.top,
          left: relOffset,
        });
        continue;
      }

      // Balance margins: left half of column -> close left margin; right half / brackets -> close right margin
      const centerX = m.bounds.left + m.bounds.width / 2;
      if (centerX < paperMid && m.annotation.style !== "bracket") {
        leftSlots.push({ id, desiredTop: Math.max(4, m.bounds.top - 4), height: noteH });
      } else {
        rightSlots.push({ id, desiredTop: Math.max(4, m.bounds.top - 4), height: noteH });
      }
    }

    for (const pos of layoutMarginNotes(leftSlots, 14)) {
      result.set(pos.id, { mode: "left-margin", top: pos.top });
    }
    for (const pos of layoutMarginNotes(rightSlots, 14)) {
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

  const handleMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      if (!manualOpen) setSelection(null);
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
    setManualOpen(false);
    setManualNote("");
    setSelection({
      blockId: node.dataset.blockText,
      quote,
      top: Math.max(8, selRect.top - stageRect.top - 50),
      left: clamp(selRect.left - stageRect.left, 8, Math.max(8, stageRect.width - 330)),
    });
  };

  const renderBlockElement = (block: ReaderBlock) => {
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
    } else if (block.kind === "image" && block.imageUrl) {
      element = (
        <figure className="reader-figure">
          <img src={block.imageUrl} alt={block.alt || ""} loading="lazy" referrerPolicy="no-referrer" />
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

    const underNotes = isDesktopRail && showInk
      ? blockAnns.filter((ann) => placementMap.get(ann.id)?.mode === "under-block")
      : [];

    return (
      <div key={block.id} className="reader-block-row">
        {element}
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
                onDelete={onDeleteAnnotation}
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
          width={stageSize.width}
          height={Math.max(stageSize.height, railMinHeight)}
          aria-hidden="true"
        >
          {measured.map((m) => {
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

      {selection ? (
        <div
          className="selection-pen-bar"
          style={{ top: `${selection.top}px`, left: `${selection.left}px` }}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
        >
          <div className="pen-bar-row">
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
              onClick={() => setManualOpen((v) => !v)}
            >
              <PenLine size={13} aria-hidden="true" />
              <span>手寫批註</span>
            </button>
          </div>
          {manualOpen ? (
            <form
              className="pen-manual-form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!manualNote.trim()) return;
                const target = selection;
                const text = manualNote.trim();
                setSelection(null);
                setManualOpen(false);
                setManualNote("");
                window.getSelection()?.removeAllRanges();
                await onManualSelection({
                  blockId: target.blockId,
                  quote: target.quote,
                  style: penStyle,
                  color: penColor,
                  note: text,
                });
              }}
            >
              <input
                type="text"
                value={manualNote}
                onChange={(e) => setManualNote(e.target.value)}
                placeholder="寫下頁邊筆記…"
                aria-label="頁邊筆記內容"
                maxLength={300}
                autoFocus
              />
              <button type="submit" className="pen-action-btn is-primary">
                儲存
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {isDesktopRail ? (
        <div
          ref={leftLaneRef}
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
        {page.blocks.map((block) => renderBlockElement(block))}
      </article>

      {isDesktopRail ? (
        <div
          ref={rightLaneRef}
          className="margin-lane margin-lane-right"
          style={{ minHeight: `${Math.max(200, railMinHeight)}px` }}
        >
          {showInk && measured.length === 0 ? (
            <p className="margin-lane-hint">
              點擊上方「AI 塗鴉標註」畫重點，或反白任意詞句寫下筆記。
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
