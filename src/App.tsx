import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  AudioLines,
  CheckSquare,
  ChevronDown,
  Columns2,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FileUp,
  Folder as FolderIcon,
  FolderPlus,
  GitPullRequest,
  Globe,
  Highlighter,
  Languages,
  Layers,
  ListChecks,
  ListTree,
  Moon,
  MoreHorizontal,
  PanelLeft,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Sun,
  Tag,
  Trash2,
  Type,
  X,
} from "lucide-react";
import {
  INK_COLORS,
  type AnnotationDensity,
  type ExplainBridgeStatus,
  type Folder,
  type InkColor,
  type InteractiveBlockKind,
  type ProviderSettings,
  type SavedPage,
  type SavedPageSummary,
} from "../shared/types";
import {
  explainDraftHref,
  isReaderHandoffAttempt,
  parseReaderHandoff,
  personalTaskHref,
  prDraftHref,
  safeSuiteOrigin,
  type ReaderHandoffDraft,
  type SuiteAppId,
  type SuiteLinks,
  type SuiteManifest,
} from "../shared/suite";
import { apiAnnotateStream, apiGet, apiUploadPdf, apiWrite } from "./lib/api";
import SuiteSwitcher from "./components/SuiteSwitcher";
import InkStage from "./components/InkStage";

const HANDOFF_STORAGE_KEY = "bell.suite.handoff.reader";

const APP_NAMES: Record<SuiteAppId, string> = {
  personal: "BELL Personal",
  explain: "BELL Explain",
  pr: "BELL PR",
  reader: "BELL Web Reader",
  campaign: "BELL Campaign",
};

const SAMPLE_ARTICLE = `# 瀏覽器 Event Loop 與畫面重繪時機

許多前端卡頓並不是因為運算本身太慢，而是長任務阻塞了主執行緒，讓瀏覽器錯過 16.6ms 的繪製視窗。理解 Call Stack、Microtask Queue 與 requestAnimationFrame 的排程順序，是定位延遲的關鍵。

## Microtask 為什麼會餓死畫面更新

每當一個 Macrotask 結束後，JavaScript 引擎必須將 Microtask Queue 清空，才會進入下一輪渲染檢查。如果程式在 Promise.then 裡遞迴排入新的 Microtask，主執行緒就永遠無法交還給排版與合成階段。

\`\`\`ts
function flushQueue(items: Task[]) {
  // 改用批次切分，讓瀏覽器有機會在幀之間完成繪製
  const chunk = items.splice(0, 25);
  chunk.forEach((task) => task.run());
  if (items.length > 0) requestAnimationFrame(() => flushQueue(items));
}
\`\`\`

> 效能調校的核心原則：先量測長任務邊界，再決定要把工作移到 Web Worker 或拆成跨幀批次。`;

type Route =
  | { kind: "home" }
  | { kind: "library"; folderId?: string }
  | { kind: "topics" }
  | { kind: "page"; id: string }
  | { kind: "handoff" };

const DENSITY_OPTIONS: ReadonlyArray<{
  value: AnnotationDensity;
  label: string;
  shortLabel: string;
  freq: string;
  desc: string;
  bars: 1 | 2 | 3;
}> = [
  {
    value: "sparse",
    label: "精簡重點",
    shortLabel: "精簡",
    freq: "約 1–2 處／區段",
    desc: "只標核心結論與關鍵圖表，保留清爽閱讀留白",
    bars: 1,
  },
  {
    value: "balanced",
    label: "均衡導讀",
    shortLabel: "均衡",
    freq: "約 2–4 處／區段",
    desc: "論點、關鍵概念、實務技巧與圖表並重（預設）",
    bars: 2,
  },
  {
    value: "thorough",
    label: "深入細讀",
    shortLabel: "深入",
    freq: "約 4–7 處／區段",
    desc: "高頻詳註推導細節、專有名詞圈選與陷阱提醒",
    bars: 3,
  },
];

function DensityPreviewThumb({ level }: { level: AnnotationDensity }) {
  return (
    <svg viewBox="0 0 64 46" className="density-thumb-svg" aria-hidden="true">
      {/* Paper sheet */}
      <rect x="2" y="2" width="44" height="42" rx="2" className="d-thumb-sheet" />
      {/* Prose lines */}
      <line x1="7" y1="9" x2="31" y2="9" className="d-thumb-line is-title" />
      <line x1="7" y1="15" x2="39" y2="15" className="d-thumb-line" />
      <line x1="7" y1="20" x2="37" y2="20" className="d-thumb-line" />
      <line x1="7" y1="25" x2="40" y2="25" className="d-thumb-line" />
      <line x1="7" y1="31" x2="35" y2="31" className="d-thumb-line" />
      <line x1="7" y1="36" x2="38" y2="36" className="d-thumb-line" />
      {/* Sparse (always 1 core highlight + 1 margin note) */}
      <rect x="7" y="13.5" width="22" height="3.2" rx="0.8" className="d-thumb-ink is-amber" />
      <line x1="48" y1="15" x2="61" y2="15" className="d-thumb-note is-amber" />
      <line x1="48" y1="18" x2="57" y2="18" className="d-thumb-note-sub" />
      {/* Balanced adds middle underline + lower margin note */}
      {level !== "sparse" ? (
        <>
          <line x1="14" y1="26.8" x2="36" y2="26.8" className="d-thumb-stroke is-violet" />
          <line x1="48" y1="26" x2="61" y2="26" className="d-thumb-note is-violet" />
          <line x1="48" y1="29" x2="58" y2="29" className="d-thumb-note-sub" />
        </>
      ) : null}
      {/* Thorough adds dense box + bracket + extra margin note */}
      {level === "thorough" ? (
        <>
          <rect x="6.5" y="18.2" width="16" height="4" rx="1" className="d-thumb-box is-coral" />
          <path d="M 41 29.5 L 43 29.5 L 43 37 L 41 37" className="d-thumb-box is-mint" />
          <line x1="48" y1="7" x2="60" y2="7" className="d-thumb-note is-coral" />
          <line x1="48" y1="35" x2="61" y2="35" className="d-thumb-note is-mint" />
          <line x1="48" y1="38" x2="56" y2="38" className="d-thumb-note-sub" />
        </>
      ) : null}
    </svg>
  );
}

function DensitySelectorCards({
  value,
  onChange,
  compact = false,
}: {
  value: AnnotationDensity;
  onChange: (next: AnnotationDensity) => void;
  compact?: boolean;
}) {
  return (
    <div className={`density-cards-list ${compact ? "is-compact" : ""}`} role="radiogroup" aria-label="AI 標註數量與頻率">
      {DENSITY_OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={`density-card ${active ? "is-active" : ""}`}
            onClick={() => onChange(opt.value)}
          >
            <DensityPreviewThumb level={opt.value} />
            <span className="density-card-copy">
              <span className="density-card-head">
                <strong>{opt.label}</strong>
                <span className="density-freq-tag">{opt.freq}</span>
              </span>
              <small>{opt.desc}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function parseRoute(hash: string): Route {
  const [rawPath] = hash.replace(/^#/, "").split("?", 2);
  const path = rawPath || "/";
  if (path === "/read") return { kind: "handoff" };
  if (path === "/library") return { kind: "library" };
  if (path.startsWith("/folder/")) {
    const id = decodeURIComponent(path.slice("/folder/".length));
    return id ? { kind: "library", folderId: id } : { kind: "library" };
  }
  if (path === "/topics") return { kind: "topics" };
  if (path.startsWith("/page/")) {
    const id = decodeURIComponent(path.slice("/page/".length));
    if (id) return { kind: "page", id };
  }
  return { kind: "home" };
}

export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const saved = localStorage.getItem("bell.reader.theme.v2");
    return saved === "dark" ? "dark" : "light";
  });
  const [readingFont, setReadingFont] = useState<"sans" | "serif">(() => {
    const saved = localStorage.getItem("bell.reader.font");
    return saved === "serif" ? "serif" : "sans";
  });
  const [hash, setHash] = useState<string>(() => window.location.hash || "#/");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [densityMenuOpen, setDensityMenuOpen] = useState(false);
  const [interactiveMenuOpen, setInteractiveMenuOpen] = useState(false);
  const [interactivePromptDraft, setInteractivePromptDraft] = useState("");
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ kind: "block" | "ann"; id: string; nonce: number } | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);

  // Suite manifest
  const [suiteLinks, setSuiteLinks] = useState<SuiteLinks>({});
  const [manifestLoaded, setManifestLoaded] = useState(false);
  const [manifestError, setManifestError] = useState(false);

  // Library state
  const [pages, setPages] = useState<SavedPageSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderColor, setNewFolderColor] = useState<InkColor>("sky");

  // Active page & streaming annotation state
  const [activePage, setActivePage] = useState<SavedPage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [annotateStage, setAnnotateStage] = useState("");
  const annotateAbortRef = useRef<AbortController | null>(null);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [interactiveBusy, setInteractiveBusy] = useState(false);
  const [upgradingBlockId, setUpgradingBlockId] = useState<string | null>(null);
  const [refetching, setRefetching] = useState(false);
  const [showInk, setShowInk] = useState(true);
  const [translating, setTranslating] = useState(false);
  const [translationMode, setTranslationMode] = useState<"original" | "bilingual" | "translated">("original");
  const [pdfViewMode, setPdfViewMode] = useState<"split" | "notes" | "pdf">("split");
  const [splitPct, setSplitPct] = useState<number>(() => {
    const saved = localStorage.getItem("bell.reader.splitPct");
    const raw = saved && saved.trim() ? Number(saved) : NaN;
    return Number.isFinite(raw) ? Math.max(28, Math.min(72, raw)) : 46;
  });
  const [draggingSplit, setDraggingSplit] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const [explainStatus, setExplainStatus] = useState<ExplainBridgeStatus>({
    status: "unconfigured",
    matches: [],
  });
  const [allExplainTopics, setAllExplainTopics] = useState<{
    status: ExplainBridgeStatus["status"];
    browserOrigin?: string;
    entries: Array<{ id: string; title: string; category?: string; tags: string[]; href: string }>;
  }>({ status: "unconfigured", entries: [] });

  // Composer & Handoff state
  const [composerInput, setComposerInput] = useState("");
  const [composerTitle, setComposerTitle] = useState("");
  const [composerFolderId, setComposerFolderId] = useState<string>("");
  const [composerBusy, setComposerBusy] = useState(false);
  const [pendingPdfFile, setPendingPdfFile] = useState<File | null>(null);
  const [composerDragOver, setComposerDragOver] = useState(false);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const [handoffDraft, setHandoffDraft] = useState<ReaderHandoffDraft | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  // Settings & Error banner
  const [settings, setSettings] = useState<ProviderSettings>({
    provider: "codex",
    model: "",
    autoFolder: true,
    annotationDensity: "balanced",
  });
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);

  const currentDensity: AnnotationDensity = settings.annotationDensity ?? "balanced";
  const currentDensityMeta = DENSITY_OPTIONS.find((o) => o.value === currentDensity) ?? DENSITY_OPTIONS[1];

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("bell.reader.theme.v2", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("bell.reader.font", readingFont);
  }, [readingFont]);

  useEffect(() => {
    localStorage.setItem("bell.reader.splitPct", String(splitPct));
  }, [splitPct]);

  const closeOverlays = useCallback((keep?: "more" | "density" | "interactive" | "outline" | "sidebar") => {
    if (keep !== "more") setMoreMenuOpen(false);
    if (keep !== "density") setDensityMenuOpen(false);
    if (keep !== "interactive") setInteractiveMenuOpen(false);
    if (keep !== "outline") setOutlineOpen(false);
    if (keep !== "sidebar") setMobileSidebarOpen(false);
  }, []);

  useEffect(() => {
    if (!moreMenuOpen && !densityMenuOpen && !interactiveMenuOpen && !outlineOpen && !mobileSidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeOverlays();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreMenuOpen, densityMenuOpen, interactiveMenuOpen, outlineOpen, mobileSidebarOpen, closeOverlays]);

  useEffect(() => {
    if (!moreMenuOpen && !densityMenuOpen && !interactiveMenuOpen) return;
    const onClick = () => {
      setMoreMenuOpen(false);
      setDensityMenuOpen(false);
      setInteractiveMenuOpen(false);
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [moreMenuOpen, densityMenuOpen, interactiveMenuOpen]);

  useEffect(() => {
    const onHash = () => {
      setHash(window.location.hash || "#/");
      closeOverlays();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [closeOverlays]);

  const route = useMemo(() => parseRoute(hash), [hash]);

  useEffect(() => {
    if (route.kind !== "page") {
      setScrollProgress(0);
      return;
    }
    const updateScroll = () => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      setScrollProgress(max > 24 ? Math.min(100, Math.max(0, (window.scrollY / max) * 100)) : 0);
    };
    updateScroll();
    window.addEventListener("scroll", updateScroll, { passive: true });
    return () => window.removeEventListener("scroll", updateScroll);
  }, [route, activePage?.id]);

  const loadManifest = useCallback(async () => {
    try {
      setManifestError(false);
      const manifest = await apiGet<SuiteManifest>("/api/suite/manifest");
      const host = window.location.hostname;
      const sanitized: SuiteLinks = {};
      for (const app of ["personal", "explain", "pr", "campaign"] as const) {
        const safe = safeSuiteOrigin(manifest.links?.[app], host);
        if (safe) sanitized[app] = safe;
      }
      setSuiteLinks(sanitized);
      setManifestLoaded(true);
    } catch {
      setManifestError(true);
      setManifestLoaded(true);
    }
  }, []);

  const loadLibrary = useCallback(async () => {
    try {
      const data = await apiGet<{ pages: SavedPageSummary[]; folders: Folder[] }>("/api/pages");
      setPages(data.pages);
      setFolders(data.folders);
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "無法載入頁面清單。" });
    }
  }, []);

  useEffect(() => {
    void loadManifest();
    void loadLibrary();
    apiGet<ProviderSettings>("/api/settings")
      .then(setSettings)
      .catch(() => undefined);
  }, [loadLibrary, loadManifest]);

  // Suite Handoff (#/read?...) per Suite Contract rev. d/e
  useEffect(() => {
    if (!manifestLoaded) return;
    const currentHash = window.location.hash || "#/";
    if (isReaderHandoffAttempt(currentHash)) {
      sessionStorage.removeItem(HANDOFF_STORAGE_KEY);
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/read`);
      setHash("#/read");
      const parsed = parseReaderHandoff(currentHash, suiteLinks);
      if (!parsed.present) return;
      if (parsed.rejected) {
        const msgMap = {
          duplicate: "已忽略這份連結：包含重複欄位。",
          missing: "已忽略這份連結：缺少閱讀文字內容。",
          from: "已忽略來自未連結產品的草稿。",
          empty: "已忽略這份連結：內容為空。",
        };
        setHandoffDraft(null);
        setHandoffError(msgMap[parsed.rejected]);
        return;
      }
      if (parsed.draft) {
        setHandoffError(null);
        setHandoffDraft(parsed.draft);
        setComposerInput(parsed.draft.text);
        setComposerTitle(parsed.draft.title || "");
        sessionStorage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(parsed.draft));
      }
      return;
    }
    if (currentHash === "#/read") {
      const stored = sessionStorage.getItem(HANDOFF_STORAGE_KEY);
      if (stored) {
        try {
          const draft = JSON.parse(stored) as ReaderHandoffDraft;
          setHandoffDraft(draft);
          setComposerInput(draft.text);
          setComposerTitle(draft.title || "");
        } catch {
          sessionStorage.removeItem(HANDOFF_STORAGE_KEY);
        }
      }
    }
  }, [hash, manifestLoaded, suiteLinks]);

  // Load active page & Explain topic links when viewing #/page/:id
  useEffect(() => {
    if (route.kind !== "page") {
      annotateAbortRef.current?.abort();
      setActivePage(null);
      setOutlineOpen(false);
      return;
    }
    let cancelled = false;
    setPageLoading(true);
    setTranslationMode("original");
    setPdfViewMode("split");
    setOutlineOpen(false);
    setNotice(null);
    apiGet<SavedPage>(`/api/pages/${encodeURIComponent(route.id)}`)
      .then((page) => {
        if (cancelled) return;
        setActivePage(page);
        setPageLoading(false);
        return apiGet<ExplainBridgeStatus>(`/api/pages/${encodeURIComponent(page.id)}/explain-links`);
      })
      .then((explain) => {
        if (!cancelled && explain) setExplainStatus(explain);
      })
      .catch((err) => {
        if (cancelled) return;
        setPageLoading(false);
        setNotice({ kind: "error", text: err instanceof Error ? err.message : "無法開啟頁面。" });
      });
    return () => {
      cancelled = true;
    };
  }, [route]);

  useEffect(() => {
    if (route.kind !== "topics") return;
    apiGet<typeof allExplainTopics>("/api/explain/topics")
      .then(setAllExplainTopics)
      .catch(() => undefined);
  }, [route.kind]);

  const isComposerUrl = useMemo(() => /^https?:\/\/\S+$/i.test(composerInput.trim()), [composerInput]);
  const isComposerPdfUrl = useMemo(
    () => isComposerUrl && /\.pdf(?:$|\?)/i.test(composerInput.trim()),
    [composerInput, isComposerUrl],
  );

  const selectPdfFile = (file: File | null | undefined) => {
    if (!file) return;
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      setNotice({ kind: "error", text: "只支援 .pdf 格式文件。" });
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setNotice({ kind: "error", text: "PDF 檔案超過 15 MB 上限。" });
      return;
    }
    setNotice(null);
    setPendingPdfFile(file);
    if (!composerTitle.trim()) {
      setComposerTitle(file.name.replace(/\.pdf$/i, "").slice(0, 120));
    }
  };

  const handleOpenOrSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!composerInput.trim() && !pendingPdfFile) || composerBusy) return;
    setComposerBusy(true);
    setNotice(null);
    try {
      const res = pendingPdfFile
        ? await apiUploadPdf<{ page: SavedPage; reused: boolean }>(pendingPdfFile, {
            title: composerTitle.trim() || undefined,
            folderId: composerFolderId || null,
          })
        : await apiWrite<{ page: SavedPage; reused: boolean }>("POST", "/api/pages", {
            ...(isComposerUrl ? { url: composerInput.trim() } : { content: composerInput }),
            ...(composerTitle.trim() ? { title: composerTitle.trim() } : {}),
            folderId: composerFolderId || null,
          });
      sessionStorage.removeItem(HANDOFF_STORAGE_KEY);
      setHandoffDraft(null);
      setComposerInput("");
      setComposerTitle("");
      setPendingPdfFile(null);
      await loadLibrary();
      if (res.reused) {
        setNotice({ kind: "info", text: "此網址已保存在書庫中，已直接載入既有頁面與標註（不重複消耗 Token）。" });
      }
      window.location.hash = `#/page/${res.page.id}`;
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "無法擷取內容。" });
    } finally {
      setComposerBusy(false);
    }
  };

  const handleSelectDensity = async (next: AnnotationDensity) => {
    setSettings((s) => ({ ...s, annotationDensity: next }));
    try {
      const saved = await apiWrite<ProviderSettings>("PATCH", "/api/settings", { annotationDensity: next });
      setSettings(saved);
    } catch {
      // Non-fatal: still uses selected density on next annotate request
    }
  };

  const handleAnnotatePage = async (densityOverride?: AnnotationDensity) => {
    if (!activePage || annotating) return;
    closeOverlays();
    const chosenDensity = densityOverride ?? currentDensity;
    const controller = new AbortController();
    annotateAbortRef.current = controller;
    setAnnotating(true);
    setAnnotateStage("正在啟動 AI 塗鴉標註引擎…");
    setNotice(null);
    try {
      const res = await apiAnnotateStream<{
        page: SavedPage;
        folders: Folder[];
        explain: ExplainBridgeStatus;
      }>(activePage.id, (msg) => setAnnotateStage(msg), controller.signal, chosenDensity);
      setActivePage(res.page);
      setFolders(res.folders);
      setExplainStatus(res.explain);
      setShowInk(true);
      await loadLibrary();
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        setNotice({ kind: "info", text: "已取消 AI 塗鴉標註。" });
      } else {
        setNotice({ kind: "error", text: err instanceof Error ? err.message : "AI 標註失敗。" });
      }
    } finally {
      if (annotateAbortRef.current === controller) {
        annotateAbortRef.current = null;
      }
      setAnnotating(false);
      setAnnotateStage("");
    }
  };

  const handleCancelAnnotate = () => {
    annotateAbortRef.current?.abort();
  };

  const handleTranslatePage = async (force = false) => {
    if (!activePage || translating) return;
    if (activePage.translatedBlocks && !force) {
      setTranslationMode((cur) => (cur === "original" ? "bilingual" : cur === "bilingual" ? "translated" : "original"));
      return;
    }
    setTranslating(true);
    setNotice(null);
    try {
      const res = await apiWrite<{ page: SavedPage }>(
        "POST",
        `/api/pages/${encodeURIComponent(activePage.id)}/translate`,
      );
      setActivePage(res.page);
      setTranslationMode("bilingual");
      await loadLibrary();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "翻譯失敗，請重試。" });
    } finally {
      setTranslating(false);
    }
  };

  const handleRefetchPage = async () => {
    if (!activePage?.url || refetching) return;
    setRefetching(true);
    setNotice(null);
    try {
      const res = await apiWrite<{ page: SavedPage }>(
        "POST",
        `/api/pages/${encodeURIComponent(activePage.id)}/refetch`,
      );
      setActivePage(res.page);
      setTranslationMode("original");
      await loadLibrary();
      setNotice({ kind: "info", text: "已重新擷取最新原文並保留你的互動區塊與筆記。" });
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "重新擷取失敗。" });
    } finally {
      setRefetching(false);
    }
  };

  const handleCreateInteractiveBlock = async (opts: {
    afterBlockId: string | null;
    quote?: string;
    kind: InteractiveBlockKind;
    prompt?: string;
  }) => {
    if (!activePage || interactiveBusy) return;
    setInteractiveBusy(true);
    setNotice(null);
    try {
      const res = await apiWrite<{ page: SavedPage }>(
        "POST",
        `/api/pages/${encodeURIComponent(activePage.id)}/interactive-blocks`,
        opts,
      );
      setActivePage(res.page);
      await loadLibrary();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "無法建立互動區塊。" });
    } finally {
      setInteractiveBusy(false);
    }
  };

  const handleUpdateInteractiveState = async (blockId: string, state: Record<string, unknown>) => {
    if (!activePage) return;
    try {
      const res = await apiWrite<{ page: SavedPage }>(
        "PATCH",
        `/api/pages/${encodeURIComponent(activePage.id)}/interactive-blocks/${encodeURIComponent(blockId)}`,
        { state },
      );
      setActivePage(res.page);
    } catch {
      // Non-fatal state sync
    }
  };

  const handleUpgradeInteractiveBlock = async (blockId: string) => {
    if (!activePage || upgradingBlockId) return;
    setUpgradingBlockId(blockId);
    setNotice(null);
    try {
      const res = await apiWrite<{ page: SavedPage }>(
        "POST",
        `/api/pages/${encodeURIComponent(activePage.id)}/interactive-blocks/${encodeURIComponent(blockId)}/upgrade`,
      );
      setActivePage(res.page);
      await loadLibrary();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "AI 深化失敗，保留即時互動版本。" });
    } finally {
      setUpgradingBlockId(null);
    }
  };

  const handleDeleteInteractiveBlock = async (blockId: string) => {
    if (!activePage) return;
    try {
      const res = await apiWrite<{ page: SavedPage }>(
        "DELETE",
        `/api/pages/${encodeURIComponent(activePage.id)}/interactive-blocks/${encodeURIComponent(blockId)}`,
      );
      if (res.page) setActivePage(res.page);
      await loadLibrary();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "無法刪除互動區塊。" });
    }
  };

  const isTranslatedView = Boolean(translationMode === "translated" && activePage?.translatedBlocks);
  const displayPage = useMemo(() => {
    if (!activePage) return null;
    if (!isTranslatedView || !activePage.translatedBlocks) return activePage;
    return {
      ...activePage,
      title: activePage.translatedTitle || activePage.title,
      blocks: activePage.translatedBlocks,
    };
  }, [activePage, isTranslatedView]);

  const activeHasPdf = Boolean(activePage && (activePage.hasPdf || activePage.sourceKind === "pdf"));
  const hasMobileSubbar = Boolean(route.kind === "page" && activePage && (activeHasPdf || activePage.translatedBlocks));
  const outlineHeadings = useMemo(
    () => (activePage ? activePage.blocks.filter((b) => b.kind === "heading") : []),
    [activePage],
  );

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    try {
      const created = await apiWrite<Folder>("POST", "/api/folders", {
        name: newFolderName.trim(),
        color: newFolderColor,
      });
      setFolders((prev) => (prev.some((f) => f.id === created.id) ? prev : [...prev, created]));
      setNewFolderName("");
      setNewFolderOpen(false);
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "無法建立資料夾。" });
    }
  };

  const filteredPages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return pages.filter((p) => {
      if (route.kind === "library" && route.folderId) {
        if (route.folderId === "__unfiled__" && p.folderId !== null) return false;
        if (route.folderId !== "__unfiled__" && p.folderId !== route.folderId) return false;
      }
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.topic.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q)) ||
        (p.siteName?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [pages, route, searchQuery]);

  const topicGroups = useMemo(() => {
    const groups = new Map<string, SavedPageSummary[]>();
    for (const p of pages) {
      const key = p.topic || "未分類";
      const list = groups.get(key) ?? [];
      list.push(p);
      groups.set(key, list);
    }
    return Array.from(groups.entries()).sort((a, b) => {
      if (a[0] === "未分類") return 1;
      if (b[0] === "未分類") return -1;
      return b[1].length - a[1].length;
    });
  }, [pages]);

  const explainOrigin = explainStatus.browserOrigin || suiteLinks.explain;
  const personalOrigin = suiteLinks.personal;
  const prOrigin = suiteLinks.pr;

  const pageToExplainHref = useMemo(() => {
    if (!activePage) return undefined;
    const notesDigest = activePage.annotations
      .slice(0, 4)
      .map((a) => `• 「${a.quote}」→ ${a.note}`)
      .join("\n");
    const payload = [
      activePage.summary ? `摘要：${activePage.summary}` : activePage.excerpt,
      notesDigest ? `\n重點標註：\n${notesDigest}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return explainDraftHref(
      explainOrigin,
      {
        title: activePage.title,
        text: payload,
        back: `#/page/${activePage.id}`,
      },
      window.location.hostname,
    );
  }, [activePage, explainOrigin]);

  const pageToPersonalHref = useMemo(() => {
    if (!activePage) return undefined;
    return personalTaskHref(
      personalOrigin,
      `閱讀整理：${activePage.title}${activePage.url ? `\n${activePage.url}` : ""}`,
      `#/page/${activePage.id}`,
      window.location.hostname,
    );
  }, [activePage, personalOrigin]);

  const pageToPrHref = useMemo(() => {
    if (!activePage) return undefined;
    return prDraftHref(
      prOrigin,
      {
        title: activePage.title,
        draft: `${activePage.title}${activePage.url ? `\n${activePage.url}` : ""}${activePage.summary ? `\n\n${activePage.summary}` : ""}`,
        back: `#/page/${activePage.id}`,
      },
      window.location.hostname,
    );
  }, [activePage, prOrigin]);

  const renderPageCard = (p: SavedPageSummary) => {
    const folder = folders.find((f) => f.id === p.folderId);
    return (
      <a key={p.id} href={`#/page/${encodeURIComponent(p.id)}`} className="article-index-row">
        <div className="article-index-main">
          <div className="article-index-kicker">
            <span className="index-topic">
              <bdi>{p.topic}</bdi>
            </span>
            {folder ? (
              <span className="index-folder">
                <span className={`folder-dot dot-${folder.color}`} />
                <bdi>{folder.name}</bdi>
              </span>
            ) : null}
            {p.siteName ? (
              <span className="index-site">
                <Globe size={11} aria-hidden="true" />
                <span>{p.siteName}</span>
              </span>
            ) : null}
          </div>
          <h3>
            <bdi>{p.title}</bdi>
          </h3>
          <p>
            <bdi>{p.summary || p.excerpt}</bdi>
          </p>
        </div>
        <div className="article-index-aside">
          <span className={`ann-count-badge ${p.annotationCount > 0 ? "has-ink" : ""}`}>
            {p.annotationCount > 0 ? `${p.annotationCount} 則筆跡` : "待標註"}
          </span>
        </div>
      </a>
    );
  };

  const libraryTitle =
    route.kind === "library"
      ? route.folderId === "__unfiled__"
        ? "未歸檔"
        : route.folderId
          ? folders.find((f) => f.id === route.folderId)?.name || "資料夾"
          : "全部保存"
      : "閱讀書庫";

  const handleToggleSidebar = () => {
    if (window.matchMedia("(max-width: 900px)").matches) {
      closeOverlays("sidebar");
      setMobileSidebarOpen((v) => !v);
    } else {
      setSidebarCollapsed((v) => !v);
    }
  };

  return (
    <div className={`app-shell ${sidebarCollapsed ? "is-sidebar-collapsed" : ""}`}>
      {route.kind === "page" && scrollProgress > 0 ? (
        <div
          className="reading-progress-bar"
          style={{ transform: `scaleX(${scrollProgress / 100})` }}
          aria-hidden="true"
        />
      ) : null}

      <SuiteSwitcher
        links={suiteLinks}
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        manifestError={manifestError}
        onRetry={loadManifest}
      />

      {mobileSidebarOpen ? (
        <div
          className="sidebar-backdrop"
          onClick={() => setMobileSidebarOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      <aside
        className={`app-sidebar ${mobileSidebarOpen ? "is-open" : ""}`}
        aria-label="側邊導覽與書庫"
      >
        <div className="sidebar-head">
          <button
            type="button"
            className="suite-brand-btn"
            aria-label="切換 BELL 產品"
            onClick={() => {
              closeOverlays();
              setSwitcherOpen(true);
            }}
          >
            <span className="brand-tile" aria-hidden="true">
              <Highlighter size={14} />
            </span>
            <span className="brand-wordmark">
              <b>BELL</b> Web Reader
            </span>
            <ChevronDown size={13} className="brand-chevron" aria-hidden="true" />
          </button>
        </div>

        <div className="sidebar-scroll">
          <nav className="sidebar-nav" aria-label="主要功能">
            <a
              href="#/"
              className={`nav-row ${route.kind === "home" || route.kind === "handoff" ? "is-active" : ""}`}
            >
              <Plus size={14} aria-hidden="true" />
              <span>新增閱讀</span>
            </a>
            <a
              href="#/library"
              className={`nav-row ${route.kind === "library" && !route.folderId ? "is-active" : ""}`}
            >
              <FileText size={14} aria-hidden="true" />
              <span>全部保存</span>
              <span className="nav-count">{pages.length}</span>
            </a>
            <a
              href="#/topics"
              className={`nav-row ${route.kind === "topics" ? "is-active" : ""}`}
            >
              <Layers size={14} aria-hidden="true" />
              <span>主題歸納</span>
            </a>
          </nav>

          <section className="sidebar-section" aria-label="資料夾分類">
            <div className="rail-head">
              <span>資料夾</span>
              <button
                type="button"
                className="icon-ghost-btn is-xs"
                aria-label="新增資料夾"
                title="新增資料夾"
                onClick={() => setNewFolderOpen((v) => !v)}
              >
                <FolderPlus size={14} aria-hidden="true" />
              </button>
            </div>

            {newFolderOpen ? (
              <form className="new-folder-form" onSubmit={handleCreateFolder}>
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="資料夾名稱…"
                  aria-label="資料夾名稱"
                  maxLength={40}
                  autoFocus
                />
                <div className="new-folder-actions">
                  <div className="folder-color-row">
                    {INK_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`pen-color-dot dot-${c} ${newFolderColor === c ? "is-selected" : ""}`}
                        aria-label={c}
                        onClick={() => setNewFolderColor(c)}
                      />
                    ))}
                  </div>
                  <button type="submit" className="btn-xs-primary">
                    建立
                  </button>
                </div>
              </form>
            ) : null}

            <a
              href="#/folder/__unfiled__"
              className={`nav-row ${route.kind === "library" && route.folderId === "__unfiled__" ? "is-active" : ""}`}
            >
              <span className="folder-dot is-unfiled" aria-hidden="true" />
              <span className="folder-name">未歸檔</span>
              <span className="nav-count">{pages.filter((p) => !p.folderId).length}</span>
            </a>

            {folders.map((folder) => {
              const active = route.kind === "library" && route.folderId === folder.id;
              return (
                <div key={folder.id} className={`nav-row folder-row ${active ? "is-active" : ""}`}>
                  <a href={`#/folder/${encodeURIComponent(folder.id)}`} className="folder-row-link">
                    <span className={`folder-dot dot-${folder.color}`} aria-hidden="true" />
                    <span className="folder-name">
                      <bdi>{folder.name}</bdi>
                    </span>
                    <span className="nav-count">{folder.pageCount}</span>
                  </a>
                  <button
                    type="button"
                    className="folder-del-btn"
                    aria-label={`刪除資料夾 ${folder.name}`}
                    title="刪除資料夾（保留頁面）"
                    onClick={async () => {
                      await apiWrite("DELETE", `/api/folders/${encodeURIComponent(folder.id)}`);
                      await loadLibrary();
                      if (active) window.location.hash = "#/library";
                    }}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </section>
        </div>

        <div className="sidebar-footer">
          <button
            type="button"
            className="nav-row sidebar-action-row"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
            <span>{theme === "dark" ? "亮色紙張" : "暗色畫室"}</span>
          </button>
          <button
            type="button"
            className="nav-row sidebar-action-row"
            onClick={() => {
              closeOverlays();
              setSettingsOpen(true);
            }}
          >
            <Settings size={14} aria-hidden="true" />
            <span>模型與設定</span>
          </button>
        </div>
      </aside>

      <main className={`app-main ${hasMobileSubbar ? "has-view-pills" : ""}`}>
        <header className="main-topbar">
          <div className="main-topbar-left">
            <button
              type="button"
              className="icon-ghost-btn sidebar-toggle-btn"
              aria-label={sidebarCollapsed ? "展開側邊欄" : "收合側邊欄"}
              title={sidebarCollapsed ? "展開側邊欄" : "收合側邊欄"}
              onClick={handleToggleSidebar}
            >
              <PanelLeft size={15} aria-hidden="true" />
            </button>

            {(route.kind === "home" || route.kind === "handoff") && (
              <span className="topbar-section-title">閱讀書桌</span>
            )}

            {route.kind === "library" && (
              <div className="topbar-title-group">
                <span className="topbar-section-title">
                  <bdi>{libraryTitle}</bdi>
                </span>
                <span className="topbar-count-pill">{filteredPages.length}</span>
              </div>
            )}

            {route.kind === "topics" && (
              <span className="topbar-section-title">主題歸納與 BELL Explain 連通</span>
            )}

            {route.kind === "page" && activePage && (
              <div className="topbar-reader-meta">
                <label className="folder-select-wrap is-compact">
                  <FolderIcon size={13} aria-hidden="true" />
                  <select
                    value={activePage.folderId ?? ""}
                    aria-label="移動資料夾"
                    onChange={async (e) => {
                      const nextFolder = e.target.value || null;
                      const updated = await apiWrite<SavedPage>(
                        "PATCH",
                        `/api/pages/${encodeURIComponent(activePage.id)}`,
                        { folderId: nextFolder },
                      );
                      setActivePage(updated);
                      await loadLibrary();
                    }}
                  >
                    <option value="">未歸檔</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="reader-topic-label">
                  <bdi>{activePage.topic}</bdi>
                </span>
              </div>
            )}
          </div>

          <div className="main-topbar-right">
            {route.kind === "library" && (
              <input
                type="search"
                className="search-input is-topbar"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜尋標題、主題或標籤…"
                aria-label="搜尋保存頁面"
              />
            )}

            {route.kind === "topics" && suiteLinks.explain && (
              <a href={`${suiteLinks.explain}/`} className="btn-explain-chip">
                <AudioLines size={14} aria-hidden="true" />
                <span>開啟 BELL Explain</span>
              </a>
            )}

            {route.kind === "page" && activePage && (
              <>
                <div className="reader-quiet-group" role="group" aria-label="閱讀選項">
                  {activeHasPdf ? (
                    <div className="segmented-pill" role="group" aria-label="PDF 檢視模式">
                      {(
                        [
                          ["split", "並排"],
                          ["notes", "筆記"],
                          ["pdf", "PDF"],
                        ] as const
                      ).map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          className={`segmented-pill-btn ${pdfViewMode === mode ? "is-active" : ""}`}
                          aria-pressed={pdfViewMode === mode}
                          onClick={() => setPdfViewMode(mode)}
                        >
                          {mode === "split" ? <Columns2 size={12} aria-hidden="true" /> : null}
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {activePage.translatedBlocks ? (
                    <div className="segmented-pill" role="group" aria-label="翻譯檢視模式">
                      {(
                        [
                          ["original", "原文"],
                          ["bilingual", "並排"],
                          ["translated", "譯文"],
                        ] as const
                      ).map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          className={`segmented-pill-btn ${translationMode === mode ? "is-active" : ""}`}
                          aria-pressed={translationMode === mode}
                          onClick={() => setTranslationMode(mode)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="icon-ghost-btn"
                      disabled={translating}
                      onClick={() => void handleTranslatePage(false)}
                      title="全文翻譯成台灣繁體中文（保留程式碼與專有名詞原文）"
                    >
                      <Languages size={14} className={translating ? "spin" : ""} aria-hidden="true" />
                      <span>{translating ? "翻譯中…" : "繁中翻譯"}</span>
                    </button>
                  )}

                  <div className="more-menu-wrap" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="icon-ghost-btn is-interactive-trigger"
                      disabled={interactiveBusy}
                      aria-expanded={interactiveMenuOpen}
                      onClick={() => {
                        closeOverlays("interactive");
                        setInteractiveMenuOpen((v) => !v);
                      }}
                      title="為目前文章建立可操作的互動模擬或概念步進測驗"
                    >
                      <Plus size={14} aria-hidden="true" />
                      <span>互動區塊</span>
                    </button>
                    {interactiveMenuOpen ? (
                      <div className="interactive-popover" role="dialog" aria-label="新增互動區塊">
                        <div className="interactive-popover-head">針對目前閱讀內容新增互動</div>
                        <input
                          type="text"
                          className="interactive-popover-input"
                          value={interactivePromptDraft}
                          onChange={(e) => setInteractivePromptDraft(e.target.value)}
                          placeholder="選填想模擬的主題或概念…"
                          aria-label="互動主題提示"
                          maxLength={120}
                        />
                        <div className="interactive-popover-actions">
                          <button
                            type="button"
                            className="btn-primary is-compact"
                            disabled={interactiveBusy}
                            onClick={async () => {
                              const firstContentBlock =
                                activePage.blocks.find((b) => b.kind !== "heading" && b.kind !== "image") ??
                                activePage.blocks[0];
                              const prompt = interactivePromptDraft.trim();
                              setInteractiveMenuOpen(false);
                              setInteractivePromptDraft("");
                              await handleCreateInteractiveBlock({
                                afterBlockId: firstContentBlock?.id ?? null,
                                quote: firstContentBlock?.text.slice(0, 140),
                                kind: "simulation",
                                ...(prompt ? { prompt } : {}),
                              });
                            }}
                          >
                            <Cpu size={13} aria-hidden="true" />
                            <span>互動模擬</span>
                          </button>
                          <button
                            type="button"
                            className="btn-secondary is-compact"
                            disabled={interactiveBusy}
                            onClick={async () => {
                              const firstContentBlock =
                                activePage.blocks.find((b) => b.kind !== "heading" && b.kind !== "image") ??
                                activePage.blocks[0];
                              const prompt = interactivePromptDraft.trim();
                              setInteractiveMenuOpen(false);
                              setInteractivePromptDraft("");
                              await handleCreateInteractiveBlock({
                                afterBlockId: firstContentBlock?.id ?? null,
                                quote: firstContentBlock?.text.slice(0, 140),
                                kind: "stepper",
                                ...(prompt ? { prompt } : {}),
                              });
                            }}
                          >
                            <ListChecks size={13} aria-hidden="true" />
                            <span>概念步進</span>
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    className={`icon-ghost-btn ${outlineOpen ? "is-active" : ""}`}
                    aria-pressed={outlineOpen}
                    onClick={() => {
                      closeOverlays("outline");
                      setOutlineOpen((v) => !v);
                    }}
                    title="開啟大綱與閱讀筆跡導覽"
                  >
                    <ListTree size={14} aria-hidden="true" />
                    <span>大綱</span>
                  </button>

                  <button
                    type="button"
                    className="icon-ghost-btn"
                    onClick={() => setReadingFont((f) => (f === "sans" ? "serif" : "sans"))}
                    title={readingFont === "sans" ? "切換書卷襯線體" : "切換現代黑體"}
                  >
                    <Type size={14} aria-hidden="true" />
                    <span>{readingFont === "sans" ? "襯線" : "黑體"}</span>
                  </button>

                  {activePage.annotations.length > 0 ? (
                    <button
                      type="button"
                      className="icon-ghost-btn"
                      onClick={() => setShowInk((v) => !v)}
                      aria-pressed={showInk}
                      title={showInk ? "暫時隱藏塗鴉" : "顯示塗鴉筆跡"}
                    >
                      {showInk ? <EyeOff size={14} /> : <Eye size={14} />}
                      <span>{showInk ? "藏筆跡" : "顯筆跡"}</span>
                    </button>
                  ) : null}

                  {pageToExplainHref ? (
                    <a
                      href={pageToExplainHref}
                      className="icon-ghost-btn is-explain-link"
                      title="傳送到 BELL Explain 深入理解"
                    >
                      <AudioLines size={14} aria-hidden="true" />
                      <span>Explain</span>
                    </a>
                  ) : null}

                  <div className="more-menu-wrap" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="icon-ghost-btn"
                      aria-label="更多頁面操作"
                      aria-expanded={moreMenuOpen}
                      onClick={() => {
                        closeOverlays("more");
                        setMoreMenuOpen((v) => !v);
                      }}
                    >
                      <MoreHorizontal size={15} />
                    </button>
                    {moreMenuOpen ? (
                      <div className="more-popover" role="menu">
                        {activePage.url ? (
                          <>
                            <a
                              href={activePage.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="more-menu-item"
                              role="menuitem"
                              onClick={() => setMoreMenuOpen(false)}
                            >
                              <ExternalLink size={13} aria-hidden="true" />
                              <span>開啟原始網頁</span>
                            </a>
                            <button
                              type="button"
                              className="more-menu-item"
                              role="menuitem"
                              disabled={refetching}
                              onClick={() => {
                                setMoreMenuOpen(false);
                                void handleRefetchPage();
                              }}
                            >
                              <RefreshCw size={13} className={refetching ? "spin" : ""} aria-hidden="true" />
                              <span>{refetching ? "重新擷取中…" : "重新擷取網頁原文"}</span>
                            </button>
                          </>
                        ) : null}
                        {pageToPersonalHref ? (
                          <a
                            href={pageToPersonalHref}
                            className="more-menu-item"
                            role="menuitem"
                            onClick={() => setMoreMenuOpen(false)}
                          >
                            <CheckSquare size={13} aria-hidden="true" />
                            <span>轉成 BELL Personal 待辦</span>
                          </a>
                        ) : null}
                        {pageToPrHref ? (
                          <a
                            href={pageToPrHref}
                            className="more-menu-item"
                            role="menuitem"
                            onClick={() => setMoreMenuOpen(false)}
                          >
                            <GitPullRequest size={13} aria-hidden="true" />
                            <span>送到 BELL PR</span>
                          </a>
                        ) : null}
                        {activePage.translatedBlocks ? (
                          <button
                            type="button"
                            className="more-menu-item"
                            role="menuitem"
                            disabled={translating}
                            onClick={() => {
                              setMoreMenuOpen(false);
                              void handleTranslatePage(true);
                            }}
                          >
                            <RefreshCw size={13} aria-hidden="true" />
                            <span>重新翻譯全文（繁中）</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="more-menu-item is-danger"
                          role="menuitem"
                          onClick={async () => {
                            setMoreMenuOpen(false);
                            await apiWrite("DELETE", `/api/pages/${encodeURIComponent(activePage.id)}`);
                            await loadLibrary();
                            window.location.hash = "#/library";
                          }}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                          <span>刪除此保存頁面</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="ai-annotate-wrap" onClick={(e) => e.stopPropagation()}>
                  <div className={`ai-annotate-split ${activePage.annotatedAt ? "is-rerun" : "is-primary"}`}>
                    <button
                      type="button"
                      className="ai-annotate-main"
                      disabled={annotating}
                      onClick={() => void handleAnnotatePage()}
                      title={
                        activePage.annotatedAt
                          ? `依「${currentDensityMeta.label}」模式重新標註（保留手寫批註）`
                          : `依「${currentDensityMeta.label}」模式產生 AI 塗鴉標註`
                      }
                    >
                      {activePage.annotatedAt ? (
                        <RefreshCw size={13} className={annotating ? "spin" : ""} aria-hidden="true" />
                      ) : (
                        <Sparkles size={13} className={annotating ? "spin" : ""} aria-hidden="true" />
                      )}
                      <span>{annotating ? "標註中…" : activePage.annotatedAt ? "重跑標註" : "AI 塗鴉標註"}</span>
                      <span className="ink-rhythm-meter" aria-hidden="true" title={`目前密度：${currentDensityMeta.label}`}>
                        {[1, 2, 3].map((n) => (
                          <i key={n} className={n <= currentDensityMeta.bars ? "is-on" : ""} />
                        ))}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ai-annotate-caret"
                      disabled={annotating}
                      aria-label="選擇標註數量與頻率"
                      aria-expanded={densityMenuOpen}
                      onClick={() => {
                        closeOverlays("density");
                        setDensityMenuOpen((v) => !v);
                      }}
                    >
                      <ChevronDown size={13} aria-hidden="true" />
                    </button>
                  </div>

                  {densityMenuOpen ? (
                    <div className="density-popover" role="dialog" aria-label="設定 AI 標註數量與頻率">
                      <div className="density-popover-head">
                        <span>標註數量與頻率</span>
                        <span className="density-active-pill">{currentDensityMeta.shortLabel}</span>
                      </div>
                      <DensitySelectorCards
                        value={currentDensity}
                        onChange={(next) => void handleSelectDensity(next)}
                        compact
                      />
                      <div className="density-popover-foot">
                        <button
                          type="button"
                          className="btn-primary is-compact density-run-btn"
                          onClick={() => void handleAnnotatePage(currentDensity)}
                        >
                          <Sparkles size={12.5} aria-hidden="true" />
                          <span>
                            {activePage.annotatedAt
                              ? `以「${currentDensityMeta.label}」重跑標註`
                              : `以「${currentDensityMeta.label}」開始標註`}
                          </span>
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </header>

        {notice ? (
          <div className={`status-banner is-${notice.kind}`} role="status">
            <span>{notice.text}</span>
            <button type="button" aria-label="關閉提示" onClick={() => setNotice(null)}>
              <X size={14} />
            </button>
          </div>
        ) : null}

        {(route.kind === "home" || route.kind === "handoff") && (
          <div className="workspace-container">
            {handoffDraft?.backUrl ? (
              <a href={handoffDraft.backUrl} className="suite-return-bar">
                <ArrowLeft size={14} aria-hidden="true" />
                <span>回到 {APP_NAMES[handoffDraft.from]}</span>
              </a>
            ) : null}

            {handoffError ? (
              <div className="status-banner is-error">
                <span>{handoffError}</span>
                <button type="button" onClick={() => setHandoffError(null)} aria-label="關閉">
                  <X size={14} />
                </button>
              </div>
            ) : null}

            <section className="composer-card">
              <div className="composer-header">
                <div>
                  <span className="composer-kicker">閱讀書桌 · 永久保存、PDF 並排與原位批註</span>
                  <h1>
                    {handoffDraft
                      ? `來自 ${APP_NAMES[handoffDraft.from]}`
                      : "貼上網址、文章或上傳 PDF"}
                  </h1>
                  {handoffDraft?.truncated ? (
                    <p className="composer-sub">內容過長，已截斷為前 2,000 字</p>
                  ) : null}
                </div>
                {!composerInput && !pendingPdfFile ? (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setComposerTitle("瀏覽器 Event Loop 與畫面重繪時機");
                      setComposerInput(SAMPLE_ARTICLE);
                    }}
                  >
                    <FileText size={14} aria-hidden="true" />
                    <span>載入示範文章</span>
                  </button>
                ) : (
                  <span className="composer-mode-pill">
                    {pendingPdfFile || isComposerPdfUrl ? (
                      <FileUp size={13} />
                    ) : isComposerUrl ? (
                      <Globe size={13} />
                    ) : (
                      <FileText size={13} />
                    )}
                    <span>
                      {pendingPdfFile || isComposerPdfUrl
                        ? "PDF 文件模式 · 並排閱讀"
                        : isComposerUrl
                          ? "網址模式 · 自動擷取正文"
                          : "筆記模式 · 支援 Markdown"}
                    </span>
                  </span>
                )}
              </div>

              <form
                onSubmit={handleOpenOrSave}
                className={`composer-form ${composerDragOver ? "is-dragover" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setComposerDragOver(true);
                }}
                onDragLeave={() => setComposerDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setComposerDragOver(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file) selectPdfFile(file);
                }}
              >
                <input
                  ref={pdfInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  hidden
                  aria-label="選擇 PDF 檔案"
                  onChange={(e) => {
                    selectPdfFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <input
                  type="text"
                  className="composer-title-input"
                  value={composerTitle}
                  onChange={(e) => setComposerTitle(e.target.value)}
                  placeholder="選填標題（留空自動擷取）"
                  aria-label="標題"
                  maxLength={120}
                />
                {pendingPdfFile ? (
                  <div className="composer-pdf-chip">
                    <FileUp size={15} aria-hidden="true" />
                    <span className="composer-pdf-name">
                      <bdi>{pendingPdfFile.name}</bdi>
                    </span>
                    <span className="composer-pdf-size">
                      {(pendingPdfFile.size / (1024 * 1024)).toFixed(2)} MB
                    </span>
                    <button
                      type="button"
                      className="icon-ghost-btn is-xs"
                      aria-label="移除 PDF"
                      onClick={() => setPendingPdfFile(null)}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                ) : (
                  <textarea
                    className="composer-textarea"
                    value={composerInput}
                    onChange={(e) => setComposerInput(e.target.value)}
                    placeholder="貼上 https:// 網頁或 PDF 網址，拖曳 .pdf 檔案至此，或直接貼上文章／程式碼…"
                    aria-label="網址或閱讀內容"
                    rows={6}
                  />
                )}
                <div className="composer-footer">
                  <div className="composer-footer-left">
                    <label className="folder-select-wrap">
                      <FolderIcon size={14} aria-hidden="true" />
                      <select
                        value={composerFolderId}
                        onChange={(e) => setComposerFolderId(e.target.value)}
                        aria-label="選擇保存資料夾"
                      >
                        <option value="">自動／暫不指定資料夾</option>
                        {folders.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="btn-secondary is-compact"
                      onClick={() => pdfInputRef.current?.click()}
                    >
                      <FileUp size={13} aria-hidden="true" />
                      <span>上傳 PDF</span>
                    </button>
                  </div>
                  <div className="composer-actions">
                    {handoffDraft ? (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          sessionStorage.removeItem(HANDOFF_STORAGE_KEY);
                          setHandoffDraft(null);
                          setComposerInput("");
                          setComposerTitle("");
                          window.location.hash = "#/";
                        }}
                      >
                        捨棄
                      </button>
                    ) : null}
                    <button
                      type="submit"
                      className="btn-primary"
                      disabled={(!composerInput.trim() && !pendingPdfFile) || composerBusy}
                    >
                      {composerBusy ? "擷取保存中…" : "保存並開始閱讀"}
                    </button>
                  </div>
                </div>
              </form>
            </section>

            {pages.length > 0 ? (
              <section className="recent-section">
                <div className="section-title-row">
                  <h2>最近保存的閱讀筆記</h2>
                  <a href="#/library" className="text-link">
                    查看全部（{pages.length}）
                  </a>
                </div>
                <div className="article-index">{pages.slice(0, 6).map(renderPageCard)}</div>
              </section>
            ) : null}
          </div>
        )}

        {route.kind === "library" && (
          <div className="workspace-container is-library">
            {filteredPages.length === 0 ? (
              <div className="empty-box">
                <p>目前沒有符合條件的頁面。</p>
                <a href="#/" className="btn-primary">
                  新增頁面
                </a>
              </div>
            ) : (
              <div className="article-index">{filteredPages.map(renderPageCard)}</div>
            )}
          </div>
        )}

        {route.kind === "topics" && (
          <div className="workspace-container is-topics">
            {topicGroups.length === 0 ? (
              <div className="empty-box">
                <p>保存網頁並執行 AI 塗鴉標註後，會自動依主題歸納並配對 Explain 筆記。</p>
                <a href="#/" className="btn-primary">
                  開始閱讀
                </a>
              </div>
            ) : (
              <div className="topic-groups-list">
                {topicGroups.map(([topic, items]) => {
                  const norm = topic.toLowerCase();
                  const linkedExplain = allExplainTopics.entries.filter(
                    (entry) =>
                      topic !== "未分類" &&
                      (entry.title.toLowerCase().includes(norm) ||
                        norm.includes(entry.title.toLowerCase()) ||
                        entry.tags.some((t) => t.toLowerCase().includes(norm) || norm.includes(t.toLowerCase()))),
                  );
                  return (
                    <section key={topic} className="topic-group-card">
                      <div className="topic-group-head">
                        <div className="topic-group-title">
                          <Tag size={15} aria-hidden="true" />
                          <h2>
                            <bdi>{topic}</bdi>
                          </h2>
                          <span className="nav-count">{items.length} 頁</span>
                        </div>
                        {linkedExplain.length > 0 && (allExplainTopics.browserOrigin || suiteLinks.explain) ? (
                          <div className="explain-smart-chips">
                            {linkedExplain.slice(0, 3).map((e) => (
                              <a
                                key={e.id}
                                href={`${allExplainTopics.browserOrigin || suiteLinks.explain}/${e.href}`}
                                className="btn-explain-chip"
                              >
                                <AudioLines size={13} aria-hidden="true" />
                                <span>
                                  Explain · <bdi>{e.title}</bdi>
                                </span>
                              </a>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className="topic-pages-rows">
                        {items.map((p) => (
                          <a
                            key={p.id}
                            href={`#/page/${encodeURIComponent(p.id)}`}
                            className="topic-page-row"
                          >
                            <span className="topic-page-name">
                              <bdi>{p.title}</bdi>
                            </span>
                            <span className="topic-page-tags">
                              {p.tags.slice(0, 3).map((t) => (
                                <span key={t} className="mini-tag">
                                  <bdi>{t}</bdi>
                                </span>
                              ))}
                            </span>
                            <span className="ann-count-badge">{p.annotationCount} 則標註</span>
                          </a>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {route.kind === "page" && (
          <div className={`reader-view-wrap ${activeHasPdf && pdfViewMode === "split" ? "is-split" : ""} ${draggingSplit ? "is-dragging-split" : ""}`}>
            {pageLoading ? (
              <div className="empty-box">
                <p>載入頁面中…</p>
              </div>
            ) : activePage ? (
              <>
                <AnimatePresence>
                  {annotating ? (
                    <motion.div
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      className="ai-ink-progress-card"
                      role="status"
                      aria-live="polite"
                    >
                      <div className="ai-ink-progress-main">
                        <span className="ai-ink-pulse" aria-hidden="true">
                          <Highlighter size={15} />
                        </span>
                        <div>
                          <strong>{annotateStage || "AI 正在閱讀全文並繪製塗鴉標註…"}</strong>
                          <small>完成後筆跡將永久保存於本機書庫，下次閱讀不需重跑</small>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn-secondary is-compact"
                        onClick={handleCancelAnnotate}
                      >
                        取消
                      </button>
                    </motion.div>
                  ) : null}
                </AnimatePresence>

                {activeHasPdf && pdfViewMode === "pdf" ? (
                  <section className="reader-pdf-pane is-solo" aria-label="PDF 原檔檢視">
                    <div className="pdf-pane-bar">
                      <span className="pdf-pane-title">
                        <FileText size={13} aria-hidden="true" />
                        <bdi>{activePage.title}</bdi>
                        {activePage.pdfPageCount ? (
                          <span className="pdf-page-count">{activePage.pdfPageCount} 頁</span>
                        ) : null}
                      </span>
                      <a
                        href={`/api/pages/${encodeURIComponent(activePage.id)}/pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="pdf-pane-link"
                      >
                        <span>新分頁開啟</span>
                        <ExternalLink size={12} aria-hidden="true" />
                      </a>
                    </div>
                    <iframe
                      className="reader-pdf-frame"
                      src={`/api/pages/${encodeURIComponent(activePage.id)}/pdf`}
                      title={`${activePage.title} PDF`}
                    />
                  </section>
                ) : (
                  <div
                    ref={splitContainerRef}
                    className={activeHasPdf && pdfViewMode === "split" ? "reader-split-layout" : "reader-single-layout"}
                    style={
                      activeHasPdf && pdfViewMode === "split"
                        ? ({ "--split-left": `${splitPct}%` } as React.CSSProperties)
                        : undefined
                    }
                  >
                    {activeHasPdf && pdfViewMode === "split" ? (
                      <>
                        <section className="reader-pdf-pane" aria-label="PDF 原檔">
                          <div className="pdf-pane-bar">
                            <span className="pdf-pane-title">
                              <FileText size={13} aria-hidden="true" />
                              <bdi>{activePage.title}</bdi>
                              {activePage.pdfPageCount ? (
                                <span className="pdf-page-count">{activePage.pdfPageCount} 頁</span>
                              ) : null}
                            </span>
                            <a
                              href={`/api/pages/${encodeURIComponent(activePage.id)}/pdf`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="pdf-pane-link"
                            >
                              <span>新分頁</span>
                              <ExternalLink size={12} aria-hidden="true" />
                            </a>
                          </div>
                          <iframe
                            className="reader-pdf-frame"
                            src={`/api/pages/${encodeURIComponent(activePage.id)}/pdf`}
                            title={`${activePage.title} PDF`}
                          />
                        </section>

                        <div
                          className="split-resizer"
                          role="separator"
                          aria-orientation="vertical"
                          aria-label="調整 PDF 與筆記欄寬"
                          aria-valuemin={28}
                          aria-valuemax={72}
                          aria-valuenow={Math.round(splitPct)}
                          tabIndex={0}
                          onPointerDown={(e) => {
                            e.preventDefault();
                            const target = e.currentTarget;
                            target.setPointerCapture(e.pointerId);
                            setDraggingSplit(true);
                            const onMove = (ev: PointerEvent) => {
                              const rect = splitContainerRef.current?.getBoundingClientRect();
                              if (!rect || rect.width < 200) return;
                              const next = ((ev.clientX - rect.left) / rect.width) * 100;
                              setSplitPct(Math.max(28, Math.min(72, Number(next.toFixed(1)))));
                            };
                            const onUp = () => {
                              setDraggingSplit(false);
                              target.removeEventListener("pointermove", onMove);
                              target.removeEventListener("pointerup", onUp);
                              target.removeEventListener("pointercancel", onUp);
                            };
                            target.addEventListener("pointermove", onMove);
                            target.addEventListener("pointerup", onUp);
                            target.addEventListener("pointercancel", onUp);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "ArrowLeft") {
                              e.preventDefault();
                              setSplitPct((p) => Math.max(28, p - 2));
                            } else if (e.key === "ArrowRight") {
                              e.preventDefault();
                              setSplitPct((p) => Math.min(72, p + 2));
                            }
                          }}
                        />
                      </>
                    ) : null}

                    <div className="reader-notes-pane">
                      <header className="reader-doc-header">
                        <div className="reader-doc-source">
                          {activePage.siteName ? (
                            <span className="source-domain-chip">
                              <Globe size={12} aria-hidden="true" />
                              <span>{activePage.siteName}</span>
                            </span>
                          ) : (
                            <span className="source-domain-chip">
                              <FileText size={12} aria-hidden="true" />
                              <span>保存筆記</span>
                            </span>
                          )}
                          {activePage.url ? (
                            <a
                              href={activePage.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="source-ext-link"
                            >
                              <span>原始網頁</span>
                              <ExternalLink size={12} aria-hidden="true" />
                            </a>
                          ) : null}
                        </div>
                        <h1>
                          <bdi>{displayPage?.title ?? activePage.title}</bdi>
                        </h1>

                        {explainStatus.matches.length > 0 && explainOrigin ? (
                          <div className="explain-matches-bar">
                            <span className="explain-bar-label">
                              <AudioLines size={13} aria-hidden="true" />
                              <span>BELL Explain 相關主題筆記：</span>
                            </span>
                            {explainStatus.matches.map((m) => (
                              <a
                                key={m.id}
                                href={`${explainOrigin}/${m.href}`}
                                className="btn-explain-chip"
                                title={m.reason}
                              >
                                <span>
                                  <bdi>{m.title}</bdi>
                                </span>
                              </a>
                            ))}
                          </div>
                        ) : null}
                      </header>

                      <InkStage
                        page={translationMode === "bilingual" ? activePage : (displayPage ?? activePage)}
                        theme={theme}
                        showInk={showInk}
                        translationMode={activePage.translatedBlocks ? translationMode : "original"}
                        translatedBlocks={activePage.translatedBlocks}
                        readingFont={readingFont}
                        explainOrigin={explainOrigin}
                        selectionBusy={selectionBusy}
                        interactiveBusy={interactiveBusy}
                        upgradingBlockId={upgradingBlockId}
                        focusRequest={focusRequest}
                        onAiSelection={async (sel) => {
                          setSelectionBusy(true);
                          setNotice(null);
                          try {
                            const res = await apiWrite<{ page: SavedPage }>(
                              "POST",
                              `/api/pages/${encodeURIComponent(activePage.id)}/annotate-selection`,
                              sel,
                            );
                            setActivePage(res.page);
                            setShowInk(true);
                            await loadLibrary();
                          } catch (err) {
                            setNotice({
                              kind: "error",
                              text: err instanceof Error ? err.message : "選取標註失敗。",
                            });
                          } finally {
                            setSelectionBusy(false);
                          }
                        }}
                        onManualSelection={async (sel) => {
                          try {
                            const res = await apiWrite<{ page: SavedPage }>(
                              "POST",
                              `/api/pages/${encodeURIComponent(activePage.id)}/annotations`,
                              sel,
                            );
                            setActivePage(res.page);
                            setShowInk(true);
                            await loadLibrary();
                          } catch (err) {
                            setNotice({
                              kind: "error",
                              text: err instanceof Error ? err.message : "無法儲存批註。",
                            });
                          }
                        }}
                        onUpdateAnnotation={async (annotationId, patch) => {
                          try {
                            const res = await apiWrite<{ page: SavedPage }>(
                              "PATCH",
                              `/api/pages/${encodeURIComponent(activePage.id)}/annotations/${encodeURIComponent(annotationId)}`,
                              patch,
                            );
                            setActivePage(res.page);
                            await loadLibrary();
                          } catch (err) {
                            setNotice({
                              kind: "error",
                              text: err instanceof Error ? err.message : "無法更新標註。",
                            });
                          }
                        }}
                        onDeleteAnnotation={async (annotationId) => {
                          try {
                            const res = await apiWrite<{ page: SavedPage }>(
                              "DELETE",
                              `/api/pages/${encodeURIComponent(activePage.id)}/annotations/${encodeURIComponent(annotationId)}`,
                            );
                            if (res.page) setActivePage(res.page);
                            await loadLibrary();
                          } catch (err) {
                            setNotice({
                              kind: "error",
                              text: err instanceof Error ? err.message : "無法刪除標註。",
                            });
                          }
                        }}
                        onCreateInteractiveBlock={handleCreateInteractiveBlock}
                        onUpdateInteractiveState={handleUpdateInteractiveState}
                        onUpgradeInteractiveBlock={handleUpgradeInteractiveBlock}
                        onDeleteInteractiveBlock={handleDeleteInteractiveBlock}
                      />
                    </div>
                  </div>
                )}

                {outlineOpen ? (
                  <aside className="reader-outline-drawer" aria-label="文章大綱與閱讀筆跡">
                    <div className="outline-drawer-head">
                      <span>大綱與筆跡</span>
                      <button
                        type="button"
                        className="icon-ghost-btn is-xs"
                        aria-label="關閉大綱面板"
                        onClick={() => setOutlineOpen(false)}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                    <div className="outline-drawer-body">
                      <section className="outline-section">
                        <h4>段落大綱（{outlineHeadings.length}）</h4>
                        {outlineHeadings.length === 0 ? (
                          <p className="outline-empty">此文件沒有顯式標題區塊。</p>
                        ) : (
                          <div className="outline-list">
                            {outlineHeadings.map((h) => (
                              <button
                                key={h.id}
                                type="button"
                                className={`outline-item level-${h.level ?? 2}`}
                                onClick={() => {
                                  setFocusRequest({ kind: "block", id: h.id, nonce: Date.now() });
                                  if (window.matchMedia("(max-width: 900px)").matches) setOutlineOpen(false);
                                }}
                              >
                                <bdi>{h.text}</bdi>
                              </button>
                            ))}
                          </div>
                        )}
                      </section>
                      <section className="outline-section">
                        <h4>閱讀筆跡（{activePage.annotations.length}）</h4>
                        {activePage.annotations.length === 0 ? (
                          <p className="outline-empty">尚未建立手寫或 AI 標註。</p>
                        ) : (
                          <div className="outline-list">
                            {activePage.annotations.map((ann) => (
                              <button
                                key={ann.id}
                                type="button"
                                className="outline-ann-item"
                                onClick={() => {
                                  setShowInk(true);
                                  setFocusRequest({ kind: "ann", id: ann.id, nonce: Date.now() });
                                  if (window.matchMedia("(max-width: 900px)").matches) setOutlineOpen(false);
                                }}
                              >
                                <span className={`outline-ann-dot dot-${ann.color}`} />
                                <span className="outline-ann-copy">
                                  <strong>{ann.label || ann.topic || "標註"}</strong>
                                  <small>
                                    <bdi>{ann.note}</bdi>
                                  </small>
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </section>
                    </div>
                  </aside>
                ) : null}
              </>
            ) : null}
          </div>
        )}
      </main>

      <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="p-dialog-overlay" />
          <Dialog.Content className="p-dialog-content">
            <div className="p-dialog-head">
              <Dialog.Title>模型與自動歸檔設定</Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="icon-ghost-btn" aria-label="關閉設定">
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <form
              className="settings-form"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  const saved = await apiWrite<ProviderSettings>("PATCH", "/api/settings", settings);
                  setSettings(saved);
                  setSettingsOpen(false);
                } catch (err) {
                  setNotice({ kind: "error", text: err instanceof Error ? err.message : "儲存設定失敗。" });
                }
              }}
            >
              <label className="field-block">
                <span>AI 供應商</span>
                <select
                  value={settings.provider}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      provider: e.target.value as ProviderSettings["provider"],
                    }))
                  }
                >
                  <option value="codex">Codex CLI（本機登入）</option>
                  <option value="claude">Claude CLI（本機登入）</option>
                  <option value="antigravity">Antigravity CLI（本機 agy）</option>
                  <option value="api">OpenAI 相容 API（AI_API_KEY）</option>
                </select>
              </label>

              <label className="field-block">
                <span>指定模型（選填，留空使用預設）</span>
                <input
                  type="text"
                  value={settings.model}
                  onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
                  placeholder="例如 gpt-5 / claude-sonnet-4-5 / gemini-3.8-flash-medium"
                />
              </label>

              <div className="field-block">
                <span>AI 預設標註數量與頻率</span>
                <DensitySelectorCards
                  value={currentDensity}
                  onChange={(next) => setSettings((s) => ({ ...s, annotationDensity: next }))}
                />
              </div>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.autoFolder}
                  onChange={(e) => setSettings((s) => ({ ...s, autoFolder: e.target.checked }))}
                />
                <span>AI 標註時自動將未歸檔頁面歸入對應主題資料夾</span>
              </label>

              <div className="dialog-actions">
                <Dialog.Close asChild>
                  <button type="button" className="btn-secondary">
                    取消
                  </button>
                </Dialog.Close>
                <button type="submit" className="btn-primary">
                  儲存設定
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
