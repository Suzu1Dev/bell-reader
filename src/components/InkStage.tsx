import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
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
  seededJitter,
  wavyUnderlinePath,
  type BoxRect,
} from "../lib/ink-geometry";

interface MeasuredAnchor {
  annotation: PageAnnotation;
  rects: BoxRect[];
  bounds: BoxRect;
  anchorX: number;
  anchorY: number;
}

interface PendingSelection {
  blockId: string;
  quote: string;
  top: number;
  left: number;
}

const STYLE_LABELS: Record<InkStyle, string> = {
  highlight: "螢光筆",
  underline: "手繪底線",
  box: "手繪圈選",
  bracket: "段落括號",
};

const COLOR_NAMES: Record<InkColor, string> = {
  amber: "琥珀黃",
  mint: "薄荷綠",
  violet: "靛紫",
  coral: "珊瑚紅",
  sky: "天青藍",
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

function MarginCard({
  annotation,
  active,
  explainOrigin,
  pageId,
  pageTitle,
  onActivate,
  onDelete,
  styleTop,
  cardRef,
}: {
  annotation: PageAnnotation;
  active: boolean;
  explainOrigin?: string;
  pageId: string;
  pageTitle: string;
  onActivate: () => void;
  onDelete: (id: string) => void;
  styleTop?: number;
  cardRef?: (el: HTMLElement | null) => void;
}) {
  const tilt = useMemo(() => {
    const jitter = seededJitter(`tilt:${annotation.id}`)();
    return Number((jitter * 0.65).toFixed(2));
  }, [annotation.id]);

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

  const shortQuote =
    annotation.quote.length > 40 ? `${annotation.quote.slice(0, 40)}…` : annotation.quote;

  return (
    <motion.aside
      ref={cardRef}
      initial={{ opacity: 0, y: 6, rotate: tilt }}
      animate={{
        opacity: 1,
        y: 0,
        x: active ? -3 : 0,
        rotate: active ? 0 : tilt,
      }}
      transition={{ type: "spring", stiffness: 360, damping: 28 }}
      className={`margin-note-card ink-card-${annotation.color} ${active ? "is-active" : ""}`}
      style={styleTop !== undefined ? { top: `${styleTop}px` } : undefined}
      onMouseEnter={onActivate}
      onClick={onActivate}
    >
      <span className={`margin-note-tape ink-tape-${annotation.color}`} aria-hidden="true" />
      <div className="margin-note-head">
        <span className={`margin-note-badge ink-badge-${annotation.color}`}>
          {annotation.label || STYLE_LABELS[annotation.style]}
        </span>
        {annotation.topic ? (
          <span className="margin-note-topic">
            <bdi>{annotation.topic}</bdi>
          </span>
        ) : null}
        <span className="margin-note-actions">
          {explainHref ? (
            <a
              href={explainHref}
              className="margin-note-btn"
              title="送到 BELL Explain 深入解釋"
              aria-label="送到 BELL Explain"
              onClick={(e) => e.stopPropagation()}
            >
              <AudioLines size={12} aria-hidden="true" />
              <span>Explain</span>
            </a>
          ) : null}
          <button
            type="button"
            className="margin-note-btn is-danger"
            aria-label="刪除此標註"
            title="刪除此標註"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(annotation.id);
            }}
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>
        </span>
      </div>
      {shortQuote ? (
        <div className="margin-note-quote">
          <bdi>「{shortQuote}」</bdi>
        </div>
      ) : null}
      <p className="margin-note-body">
        <bdi>{annotation.note}</bdi>
      </p>
    </motion.aside>
  );
}

export default function InkStage({
  page,
  showInk,
  readingFont = "sans",
  explainOrigin,
  selectionBusy,
  onAiSelection,
  onManualSelection,
  onDeleteAnnotation,
}: {
  page: SavedPage;
  showInk: boolean;
  readingFont?: "sans" | "serif";
  explainOrigin?: string;
  selectionBusy: boolean;
  onAiSelection: (input: { blockId: string; quote: string; style: InkStyle; color: InkColor }) => Promise<void>;
  onManualSelection: (input: {
    blockId: string;
    quote: string;
    style: InkStyle;
    color: InkColor;
    note: string;
  }) => Promise<void>;
  onDeleteAnnotation: (annotationId: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const blockRefs = useRef<Map<string, HTMLElement>>(new Map());
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());

  const [activeId, setActiveId] = useState<string | null>(null);
  const [isDesktopRail, setIsDesktopRail] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth >= 1024 : true,
  );
  const [measured, setMeasured] = useState<MeasuredAnchor[]>([]);
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({});
  const [railLeft, setRailLeft] = useState<number>(728);
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>({ width: 1040, height: 600 });

  // Selection toolbar state
  const [selection, setSelection] = useState<PendingSelection | null>(null);
  const [penStyle, setPenStyle] = useState<InkStyle>("highlight");
  const [penColor, setPenColor] = useState<InkColor>("amber");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualNote, setManualNote] = useState("");

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
    if (!stageEl) return;
    const desktop = window.innerWidth >= 1024;
    setIsDesktopRail(desktop);

    const stageRect = stageEl.getBoundingClientRect();
    if (railRef.current && desktop) {
      const rr = railRef.current.getBoundingClientRect();
      setRailLeft(rr.left - stageRect.left);
    }

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
      const lastRect = rects[rects.length - 1];
      nextMeasured.push({
        annotation: ann,
        rects,
        bounds,
        anchorX: ann.style === "bracket" ? bounds.left + bounds.width + 13 : lastRect.left + lastRect.width + 5,
        anchorY: ann.style === "bracket" ? bounds.top + bounds.height / 2 : lastRect.top + lastRect.height / 2,
      });
    }

    const heights: Record<string, number> = {};
    for (const [id, el] of cardRefs.current.entries()) {
      heights[id] = el.offsetHeight || 110;
    }

    setMeasured(nextMeasured);
    setCardHeights(heights);
    setStageSize({
      width: Math.max(stageEl.scrollWidth, stageRect.width),
      height: Math.max(stageEl.scrollHeight, stageRect.height),
    });
  }, [page.annotations]);

  useLayoutEffect(() => {
    recomputeGeometry();
  }, [recomputeGeometry, page.id, showInk, readingFont]);

  useEffect(() => {
    const stageEl = stageRef.current;
    if (!stageEl) return;
    const ro = new ResizeObserver(() => recomputeGeometry());
    ro.observe(stageEl);
    window.addEventListener("resize", recomputeGeometry);
    let cancelled = false;
    document.fonts?.ready?.then(() => {
      if (!cancelled) recomputeGeometry();
    });
    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener("resize", recomputeGeometry);
    };
  }, [recomputeGeometry]);

  const positionedMap = useMemo(() => {
    const slots = measured.map((m) => ({
      id: m.annotation.id,
      desiredTop: Math.max(8, m.bounds.top - 8),
      height: cardHeights[m.annotation.id] ?? 112,
    }));
    const positioned = layoutMarginNotes(slots, 16);
    return new Map(positioned.map((p) => [p.id, p.top]));
  }, [measured, cardHeights]);

  const railMinHeight = useMemo(() => {
    let maxBottom = 0;
    for (const m of measured) {
      const top = positionedMap.get(m.annotation.id) ?? 0;
      const h = cardHeights[m.annotation.id] ?? 112;
      maxBottom = Math.max(maxBottom, top + h + 20);
    }
    return maxBottom;
  }, [measured, positionedMap, cardHeights]);

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
      top: Math.max(8, selRect.top - stageRect.top - 52),
      left: Math.min(
        Math.max(8, selRect.left - stageRect.left),
        Math.max(8, stageRect.width - 320),
      ),
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

    return (
      <div key={block.id} className="reader-block-row">
        {element}
        {!isDesktopRail && showInk && blockAnns.length > 0 ? (
          <div className="mobile-margin-stack">
            {blockAnns.map((ann) => (
              <MarginCard
                key={ann.id}
                annotation={ann}
                active={activeId === ann.id}
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

  return (
    <div
      ref={stageRef}
      className={`ink-stage ${isDesktopRail ? "has-rail" : "is-compact"}`}
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
            const { annotation, rects, bounds, anchorX, anchorY } = m;
            const isActive = activeId === annotation.id;
            const cardTop = positionedMap.get(annotation.id);
            const targetY = (cardTop ?? bounds.top) + 26;
            const colorVar = `var(--ink-${annotation.color}-stroke)`;
            const washVar = `var(--ink-${annotation.color}-wash)`;

            return (
              <g
                key={annotation.id}
                className={`ink-stroke-group ${isActive ? "is-active" : ""}`}
              >
                {annotation.style === "highlight" &&
                  rects.map((rect, idx) => (
                    <path
                      key={idx}
                      d={highlighterPath(rect, `${annotation.id}:${idx}`)}
                      fill={washVar}
                      opacity={isActive ? 1 : 0.88}
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
                      strokeWidth={isActive ? 2.1 : 1.55}
                      strokeLinecap="round"
                    />
                  ))}
                {annotation.style === "box" &&
                  rects.map((rect, idx) => (
                    <path
                      key={idx}
                      d={handBoxPath(rect, `${annotation.id}:${idx}`)}
                      fill={washVar}
                      fillOpacity={isActive ? 0.42 : 0.25}
                      stroke={colorVar}
                      strokeWidth={isActive ? 2.05 : 1.55}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ))}
                {annotation.style === "bracket" && (
                  <path
                    d={bracketPath(bounds, annotation.id)}
                    fill="none"
                    stroke={colorVar}
                    strokeWidth={isActive ? 2.2 : 1.75}
                    strokeLinecap="round"
                  />
                )}
                {isDesktopRail && cardTop !== undefined && railLeft > anchorX + 8 ? (
                  <path
                    d={leaderArrowPath(anchorX, anchorY, railLeft - 6, targetY, annotation.id)}
                    fill="none"
                    stroke={colorVar}
                    strokeWidth={isActive ? 1.65 : 1.15}
                    strokeDasharray={isActive ? undefined : "4 3"}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={isActive ? 0.96 : 0.54}
                  />
                ) : null}
              </g>
            );
          })}
        </svg>
      ) : null}

      <AnimatePresence>
        {selection ? (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.97 }}
            transition={{ duration: 0.14 }}
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
          </motion.div>
        ) : null}
      </AnimatePresence>

      <article className={`reader-paper ${readingFont === "serif" ? "is-serif" : ""}`}>
        {page.summary ? (
          <div className="reader-ai-summary">
            <span className="summary-scribble-tag">AI 導讀速記</span>
            <p>
              <bdi>{page.summary}</bdi>
            </p>
          </div>
        ) : null}
        {page.blocks.map((block) => renderBlockElement(block))}
      </article>

      {isDesktopRail ? (
        <div
          ref={railRef}
          className="margin-rail"
          style={{ minHeight: `${Math.max(240, railMinHeight)}px` }}
        >
          {showInk && measured.length === 0 ? (
            <div className="margin-rail-empty">
              <Sparkles size={15} aria-hidden="true" />
              <span>按下右上角「AI 塗鴉標註」自動畫重點，或反白任一句文字加上眉批。</span>
            </div>
          ) : null}
          {showInk
            ? measured.map((m) => (
                <MarginCard
                  key={m.annotation.id}
                  annotation={m.annotation}
                  active={activeId === m.annotation.id}
                  explainOrigin={explainOrigin}
                  pageId={page.id}
                  pageTitle={page.title}
                  onActivate={() => setActiveId(m.annotation.id)}
                  onDelete={onDeleteAnnotation}
                  styleTop={positionedMap.get(m.annotation.id) ?? m.bounds.top}
                  cardRef={(el) => {
                    if (el) cardRefs.current.set(m.annotation.id, el);
                    else cardRefs.current.delete(m.annotation.id);
                  }}
                />
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}
