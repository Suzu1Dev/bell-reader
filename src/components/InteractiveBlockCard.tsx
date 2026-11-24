import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Cpu,
  ListChecks,
  Maximize2,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import type { InteractiveBlock } from "../../shared/types";

export function parseSimulationHeightMessage(
  event: { source: unknown; origin: string; data: unknown },
  targets: {
    inlineWin?: unknown;
    modalWin?: unknown;
    blockId: string;
    inlineToken: string;
    modalToken: string;
    parentOrigin?: string;
  },
): { target: "inline" | "modal"; height: number } | null {
  const allowedOrigin = targets.parentOrigin ?? (typeof window !== "undefined" ? window.location.origin : "");
  if (event.origin !== "null" && (!allowedOrigin || event.origin !== allowedOrigin)) return null;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return null;
  if (data.type !== "bell-reader-sim-height") return null;
  if (data.blockId !== targets.blockId) return null;
  if (typeof data.height !== "number" || !Number.isFinite(data.height)) return null;
  const height = Math.max(160, Math.min(720, Math.round(data.height)));
  if (targets.inlineWin && event.source === targets.inlineWin && targets.inlineToken && data.frameToken === targets.inlineToken) {
    return { target: "inline", height };
  }
  if (targets.modalWin && event.source === targets.modalWin && targets.modalToken && data.frameToken === targets.modalToken) {
    return { target: "modal", height };
  }
  return null;
}

function makeFrameToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export default function InteractiveBlockCard({
  block,
  pageId,
  theme,
  upgrading,
  onUpdateState,
  onUpgrade,
  onDelete,
  onGeometryChange,
}: {
  block: InteractiveBlock;
  pageId: string;
  theme: "dark" | "light";
  upgrading: boolean;
  onUpdateState: (blockId: string, state: Record<string, unknown>) => Promise<void>;
  onUpgrade: (blockId: string) => Promise<void>;
  onDelete: (blockId: string) => Promise<void>;
  onGeometryChange?: () => void;
}) {
  const initialStep = typeof block.state?.activeStep === "number" ? block.state.activeStep : 0;
  const initialAnswers =
    block.state?.answers && typeof block.state.answers === "object"
      ? (block.state.answers as Record<string, number>)
      : {};

  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [frameHeight, setFrameHeight] = useState(260);
  const [modalFrameHeight, setModalFrameHeight] = useState(460);
  const [stepIndex, setStepIndex] = useState(initialStep);
  const [answers, setAnswers] = useState<Record<string, number>>(initialAnswers);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const modalIframeRef = useRef<HTMLIFrameElement | null>(null);
  const [inlineToken] = useState(() => makeFrameToken());
  const [modalToken] = useState(() => makeFrameToken());

  const payloadKey = useMemo(() => JSON.stringify(block.payload), [block.payload]);

  useEffect(() => {
    setStepIndex(typeof block.state?.activeStep === "number" ? block.state.activeStep : 0);
    setAnswers(
      block.state?.answers && typeof block.state.answers === "object"
        ? (block.state.answers as Record<string, number>)
        : {},
    );
    setFrameHeight(260);
    setModalFrameHeight(460);
    // Reset only when block identity, source, or payload content changes (not on state-only PATCHes).
  }, [block.id, block.source, payloadKey]);

  useEffect(() => {
    if (block.kind !== "simulation") return;
    const onMessage = (event: MessageEvent) => {
      const parsed = parseSimulationHeightMessage(event, {
        inlineWin: iframeRef.current?.contentWindow,
        modalWin: modalIframeRef.current?.contentWindow,
        blockId: block.id,
        inlineToken,
        modalToken,
      });
      if (!parsed) return;
      if (parsed.target === "inline") {
        setFrameHeight((prev) => (prev === parsed.height ? prev : parsed.height));
        requestAnimationFrame(() => onGeometryChange?.());
      } else {
        setModalFrameHeight((prev) => (prev === parsed.height ? prev : parsed.height));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [block.id, block.kind, inlineToken, modalToken, onGeometryChange]);

  const simHash = useMemo(() => {
    const html = block.payload.html ?? "";
    let h = 2166136261;
    for (let i = 0; i < html.length; i++) {
      h ^= html.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }, [block.payload.html]);

  const frameBaseUrl = `/api/pages/${encodeURIComponent(pageId)}/interactive-blocks/${encodeURIComponent(block.id)}/frame?theme=${theme}&v=${simHash}`;
  const inlineFrameSrc = `${frameBaseUrl}&frameToken=${encodeURIComponent(inlineToken)}`;
  const modalFrameSrc = `${frameBaseUrl}&frameToken=${encodeURIComponent(modalToken)}`;

  const steps = block.payload.steps ?? [];
  const checks = block.payload.checks ?? [];
  const safeStepIdx = Math.max(0, Math.min(Math.max(0, steps.length - 1), stepIndex));
  const currentStep = steps[safeStepIdx];

  const handleSelectStep = (idx: number) => {
    setStepIndex(idx);
    void onUpdateState(block.id, { activeStep: idx });
  };

  const handleAnswer = (qIdx: number, optIdx: number) => {
    const nextAnswers = { ...answers, [String(qIdx)]: optIdx };
    setAnswers(nextAnswers);
    void onUpdateState(block.id, { answers: nextAnswers });
  };

  const renderStepperContent = () => (
    <div className="interactive-stepper">
      {steps.length > 0 && currentStep ? (
        <div className="stepper-box">
          <div className="stepper-tabs" role="tablist" aria-label="概念步驟">
            {steps.map((st, idx) => (
              <button
                key={idx}
                type="button"
                role="tab"
                aria-selected={idx === safeStepIdx}
                className={`stepper-tab ${idx === safeStepIdx ? "is-active" : ""}`}
                onClick={() => handleSelectStep(idx)}
              >
                {idx + 1}. {st.label.replace(/^步驟 \d+\s*·?\s*/, "").slice(0, 18) || `步驟 ${idx + 1}`}
              </button>
            ))}
          </div>
          <div className="stepper-panel" role="tabpanel">
            <div className="stepper-panel-head">
              <strong>{currentStep.label}</strong>
              {currentStep.highlightToken ? (
                <code className="stepper-token">{currentStep.highlightToken}</code>
              ) : null}
            </div>
            <p className="stepper-detail">
              <bdi>{currentStep.detail}</bdi>
            </p>
            <div className="stepper-nav">
              <button
                type="button"
                className="btn-secondary is-compact"
                disabled={safeStepIdx === 0}
                onClick={() => handleSelectStep(Math.max(0, safeStepIdx - 1))}
              >
                上一步
              </button>
              <span className="stepper-counter">
                {safeStepIdx + 1} / {steps.length}
              </span>
              <button
                type="button"
                className="btn-secondary is-compact"
                disabled={safeStepIdx >= steps.length - 1}
                onClick={() => handleSelectStep(Math.min(steps.length - 1, safeStepIdx + 1))}
              >
                <span>下一步</span>
                <ChevronRight size={12} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {checks.length > 0 ? (
        <div className="stepper-checks">
          {checks.map((chk, qIdx) => {
            const picked = answers[String(qIdx)];
            const answered = picked !== undefined;
            const isCorrect = picked === chk.correctIndex;
            return (
              <div key={qIdx} className="check-item">
                <p className="check-question">
                  <strong>自我檢核：</strong>
                  <bdi>{chk.question}</bdi>
                </p>
                <div className="check-options" role="radiogroup" aria-label={chk.question}>
                  {chk.options.map((opt, oIdx) => {
                    const selected = picked === oIdx;
                    const stateCls = answered
                      ? oIdx === chk.correctIndex
                        ? "is-correct"
                        : selected
                          ? "is-wrong"
                          : ""
                      : "";
                    return (
                      <button
                        key={oIdx}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`check-opt-btn ${selected ? "is-selected" : ""} ${stateCls}`}
                        onClick={() => handleAnswer(qIdx, oIdx)}
                      >
                        <span className="check-opt-index">{String.fromCharCode(65 + oIdx)}</span>
                        <span className="check-opt-text">
                          <bdi>{opt}</bdi>
                        </span>
                      </button>
                    );
                  })}
                </div>
                {answered ? (
                  <div className={`check-feedback ${isCorrect ? "is-correct" : "is-wrong"}`}>
                    {isCorrect ? (
                      <CheckCircle2 size={14} aria-hidden="true" />
                    ) : (
                      <XCircle size={14} aria-hidden="true" />
                    )}
                    <span>
                      <strong>{isCorrect ? "答對了！" : "再確認一下："}</strong>
                      <bdi>{chk.explanation}</bdi>
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <section
        className={`interactive-card is-${block.kind}`}
        data-interactive-id={block.id}
        aria-label={block.title}
      >
        <header className="interactive-card-head">
          <div className="interactive-card-title-wrap">
            <span className="interactive-kind-badge">
              {block.kind === "simulation" ? (
                <Cpu size={12} aria-hidden="true" />
              ) : (
                <ListChecks size={12} aria-hidden="true" />
              )}
              <span>{block.kind === "simulation" ? "互動模擬" : "概念步進"}</span>
            </span>
            <h4 className="interactive-card-title">
              <bdi>{block.title}</bdi>
            </h4>
            <span className={`interactive-source-pill ${block.source === "ai" ? "is-ai" : ""}`}>
              {block.source === "ai" ? "AI 增強" : "即時互動"}
            </span>
          </div>

          <div className="interactive-card-actions">
            {block.source === "deterministic" ? (
              <button
                type="button"
                className="interactive-action-btn"
                disabled={upgrading}
                onClick={() => void onUpgrade(block.id)}
                title="使用 AI 重新生成更深入的互動內容"
              >
                <Sparkles size={12} className={upgrading ? "spin" : ""} aria-hidden="true" />
                <span>{upgrading ? "深化中…" : "AI 深化"}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="interactive-action-btn"
              aria-label="放大檢視互動區塊"
              title="放大檢視互動區塊"
              onClick={() => setExpanded(true)}
            >
              <Maximize2 size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="interactive-action-btn"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "展開互動區塊" : "收合互動區塊"}
              onClick={() => {
                setCollapsed((v) => !v);
                requestAnimationFrame(() => onGeometryChange?.());
              }}
            >
              {collapsed ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronUp size={13} aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="interactive-action-btn is-danger"
              aria-label="刪除互動區塊"
              title="刪除互動區塊"
              onClick={() => void onDelete(block.id)}
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </div>
        </header>

        {!collapsed ? (
          <div className="interactive-card-body">
            {block.summary ? (
              <p className="interactive-card-summary">
                <bdi>{block.summary}</bdi>
              </p>
            ) : null}

            {block.kind === "simulation" ? (
              <iframe
                ref={iframeRef}
                className="interactive-sim-frame"
                sandbox="allow-scripts"
                src={inlineFrameSrc}
                title={block.title}
                loading="lazy"
                style={{ height: `${frameHeight}px` }}
              />
            ) : (
              renderStepperContent()
            )}
          </div>
        ) : null}
      </section>

      <Dialog.Root open={expanded} onOpenChange={setExpanded}>
        <Dialog.Portal>
          <Dialog.Overlay className="p-dialog-overlay" />
          <Dialog.Content
            className="p-dialog-content is-interactive-modal"
            {...(block.summary ? {} : { "aria-describedby": undefined })}
          >
            <header className="interactive-modal-head">
              <div className="interactive-modal-title-wrap">
                <span className="interactive-kind-badge">
                  {block.kind === "simulation" ? (
                    <Cpu size={12} aria-hidden="true" />
                  ) : (
                    <ListChecks size={12} aria-hidden="true" />
                  )}
                  <span>{block.kind === "simulation" ? "互動模擬" : "概念步進"}</span>
                </span>
                <Dialog.Title className="interactive-modal-title">
                  <bdi>{block.title}</bdi>
                </Dialog.Title>
                <span className={`interactive-source-pill ${block.source === "ai" ? "is-ai" : ""}`}>
                  {block.source === "ai" ? "AI 增強" : "即時互動"}
                </span>
              </div>
              <div className="interactive-card-actions">
                {block.source === "deterministic" ? (
                  <button
                    type="button"
                    className="interactive-action-btn"
                    disabled={upgrading}
                    onClick={() => void onUpgrade(block.id)}
                    title="使用 AI 重新生成更深入的互動內容"
                  >
                    <Sparkles size={12} className={upgrading ? "spin" : ""} aria-hidden="true" />
                    <span>{upgrading ? "深化中…" : "AI 深化"}</span>
                  </button>
                ) : null}
                <Dialog.Close asChild>
                  <button type="button" className="interactive-action-btn" aria-label="關閉放大檢視">
                    <X size={14} aria-hidden="true" />
                  </button>
                </Dialog.Close>
              </div>
            </header>
            <div className="interactive-modal-body">
              {block.summary ? (
                <Dialog.Description className="interactive-card-summary">
                  <bdi>{block.summary}</bdi>
                </Dialog.Description>
              ) : null}
              {block.kind === "simulation" ? (
                <iframe
                  ref={modalIframeRef}
                  className="interactive-sim-frame is-modal"
                  sandbox="allow-scripts"
                  src={modalFrameSrc}
                  title={`${block.title}（放大檢視）`}
                  style={{ height: `${modalFrameHeight}px` }}
                />
              ) : (
                renderStepperContent()
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
