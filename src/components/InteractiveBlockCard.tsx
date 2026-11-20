import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, ChevronUp, Cpu, ListChecks, Sparkles, Trash2, XCircle } from "lucide-react";
import type { InteractiveBlock } from "../../shared/types";

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
  const [stepIndex, setStepIndex] = useState(initialStep);
  const [answers, setAnswers] = useState<Record<string, number>>(initialAnswers);

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

  return (
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
              className="interactive-sim-frame"
              sandbox="allow-scripts"
              src={`/api/pages/${encodeURIComponent(pageId)}/interactive-blocks/${encodeURIComponent(block.id)}/frame?theme=${theme}`}
              title={block.title}
              loading="lazy"
            />
          ) : (
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
          )}
        </div>
      ) : null}
    </section>
  );
}
