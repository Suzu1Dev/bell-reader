import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  AudioLines,
  BookOpen,
  CheckSquare,
  ChevronDown,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Folder as FolderIcon,
  FolderPlus,
  Globe,
  Highlighter,
  Layers,
  Menu,
  Moon,
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
  type ExplainBridgeStatus,
  type Folder,
  type InkColor,
  type ProviderSettings,
  type SavedPage,
  type SavedPageSummary,
} from "../shared/types";
import {
  explainDraftHref,
  isReaderHandoffAttempt,
  parseReaderHandoff,
  personalTaskHref,
  safeSuiteOrigin,
  type ReaderHandoffDraft,
  type SuiteAppId,
  type SuiteLinks,
  type SuiteManifest,
} from "../shared/suite";
import { apiAnnotateStream, apiGet, apiWrite } from "./lib/api";
import SuiteSwitcher from "./components/SuiteSwitcher";
import InkStage from "./components/InkStage";

const HANDOFF_STORAGE_KEY = "bell.suite.handoff.reader";

const APP_NAMES: Record<SuiteAppId, string> = {
  personal: "BELL Personal",
  explain: "BELL Explain",
  pr: "BELL PR",
  reader: "BELL Web Reader",
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
  const [showInk, setShowInk] = useState(true);
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
  const [handoffDraft, setHandoffDraft] = useState<ReaderHandoffDraft | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  // Settings & Error banner
  const [settings, setSettings] = useState<ProviderSettings>({
    provider: "codex",
    model: "",
    autoFolder: true,
  });
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("bell.reader.theme.v2", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("bell.reader.font", readingFont);
  }, [readingFont]);

  useEffect(() => {
    const onHash = () => {
      setHash(window.location.hash || "#/");
      setSidebarOpen(false);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

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
      for (const app of ["personal", "explain", "pr"] as const) {
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
      return;
    }
    let cancelled = false;
    setPageLoading(true);
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

  const handleOpenOrSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!composerInput.trim() || composerBusy) return;
    setComposerBusy(true);
    setNotice(null);
    try {
      const trimmed = composerInput.trim();
      const res = await apiWrite<{ page: SavedPage; reused: boolean }>("POST", "/api/pages", {
        ...(isComposerUrl ? { url: trimmed } : { content: composerInput }),
        ...(composerTitle.trim() ? { title: composerTitle.trim() } : {}),
        folderId: composerFolderId || null,
      });
      sessionStorage.removeItem(HANDOFF_STORAGE_KEY);
      setHandoffDraft(null);
      setComposerInput("");
      setComposerTitle("");
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

  const handleAnnotatePage = async () => {
    if (!activePage || annotating) return;
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
      }>(activePage.id, (msg) => setAnnotateStage(msg), controller.signal);
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

  return (
    <div className="app-shell">
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

      {sidebarOpen ? (
        <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      ) : null}

      <aside className={`app-sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <div className="sidebar-top">
          <button
            type="button"
            className="suite-brand-btn"
            aria-label="切換 BELL 產品"
            onClick={() => setSwitcherOpen(true)}
          >
            <span className="brand-tile" aria-hidden="true">
              <Highlighter size={15} />
            </span>
            <span className="brand-wordmark">
              <b>BELL</b> Web Reader
            </span>
            <ChevronDown size={14} className="brand-chevron" aria-hidden="true" />
          </button>
          <a href="#/" className="new-page-btn" title="新增閱讀頁面">
            <Plus size={15} aria-hidden="true" />
            <span>新增</span>
          </a>
        </div>

        <nav className="sidebar-nav" aria-label="書庫導覽">
          <a
            href="#/"
            className={`nav-row ${route.kind === "home" || route.kind === "handoff" ? "is-active" : ""}`}
          >
            <BookOpen size={15} aria-hidden="true" />
            <span>開啟網頁／內容</span>
          </a>
          <a
            href="#/library"
            className={`nav-row ${route.kind === "library" && !route.folderId ? "is-active" : ""}`}
          >
            <Layers size={15} aria-hidden="true" />
            <span>全部保存頁面</span>
            <span className="nav-count">{pages.length}</span>
          </a>
          <a
            href="#/topics"
            className={`nav-row ${route.kind === "topics" ? "is-active" : ""}`}
          >
            <Tag size={15} aria-hidden="true" />
            <span>主題與 Explain 連通</span>
            <span className="nav-count">{topicGroups.filter(([k]) => k !== "未分類").length}</span>
          </a>

          <div className="sidebar-section-head">
            <span>資料夾</span>
            <button
              type="button"
              className="icon-ghost-btn"
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
            <FolderIcon size={14} aria-hidden="true" />
            <span>未歸檔</span>
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
        </nav>

        <div className="sidebar-footer">
          <button
            type="button"
            className="icon-ghost-btn"
            aria-label={theme === "dark" ? "切換亮色模式" : "切換暗色模式"}
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            <span>{theme === "dark" ? "亮色紙張" : "暗色畫室"}</span>
          </button>
          <button
            type="button"
            className="icon-ghost-btn"
            aria-label="模型與歸檔設定"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={15} />
            <span>設定</span>
          </button>
        </div>
      </aside>

      <main className="app-main">
        <header className="mobile-bar">
          <button
            type="button"
            className="icon-ghost-btn"
            aria-label="開啟選單"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={18} />
          </button>
          <button
            type="button"
            className="suite-brand-btn"
            aria-label="切換 BELL 產品"
            onClick={() => setSwitcherOpen(true)}
          >
            <span className="brand-tile" aria-hidden="true">
              <Highlighter size={14} />
            </span>
            <span className="brand-wordmark">
              <b>BELL</b> Web Reader
            </span>
            <ChevronDown size={13} className="brand-chevron" aria-hidden="true" />
          </button>
          <a href="#/" className="icon-ghost-btn" aria-label="新增頁面">
            <Plus size={18} />
          </a>
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
                  <span className="composer-kicker">閱讀書桌 · 永久保存與原位批註</span>
                  <h1>
                    {handoffDraft
                      ? `來自 ${APP_NAMES[handoffDraft.from]}`
                      : "貼上網址或文章內容"}
                  </h1>
                  {handoffDraft?.truncated ? (
                    <p className="composer-sub">內容過長，已截斷為前 2,000 字</p>
                  ) : null}
                </div>
                {!composerInput ? (
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
                    {isComposerUrl ? <Globe size={13} /> : <FileText size={13} />}
                    <span>{isComposerUrl ? "網址模式 · 自動擷取正文" : "筆記模式 · 支援 Markdown"}</span>
                  </span>
                )}
              </div>

              <form onSubmit={handleOpenOrSave} className="composer-form">
                <input
                  type="text"
                  className="composer-title-input"
                  value={composerTitle}
                  onChange={(e) => setComposerTitle(e.target.value)}
                  placeholder="選填標題（留空自動擷取）"
                  aria-label="標題"
                  maxLength={120}
                />
                <textarea
                  className="composer-textarea"
                  value={composerInput}
                  onChange={(e) => setComposerInput(e.target.value)}
                  placeholder="貼上 https:// 網頁網址，或直接貼上文章、技術文件、程式碼段落…"
                  aria-label="網址或閱讀內容"
                  rows={6}
                />
                <div className="composer-footer">
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
                      disabled={!composerInput.trim() || composerBusy}
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
          <div className="workspace-container">
            <div className="library-header">
              <h1>
                {route.folderId === "__unfiled__"
                  ? "未歸檔頁面"
                  : route.folderId
                    ? folders.find((f) => f.id === route.folderId)?.name || "資料夾"
                    : "全部保存頁面"}
              </h1>
              <input
                type="search"
                className="search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜尋標題、主題或標籤…"
                aria-label="搜尋保存頁面"
              />
            </div>
            {filteredPages.length === 0 ? (
              <div className="empty-box">
                <p>沒有符合的保存頁面。</p>
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
          <div className="workspace-container">
            <div className="library-header">
              <div>
                <h1>主題歸納與 BELL Explain 連通</h1>
              </div>
              {suiteLinks.explain ? (
                <a href={`${suiteLinks.explain}/`} className="btn-explain-chip">
                  <AudioLines size={14} aria-hidden="true" />
                  <span>開啟 BELL Explain</span>
                </a>
              ) : null}
            </div>
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
          <div className="reader-view-wrap">
            {pageLoading ? (
              <div className="empty-box">
                <p>載入頁面中…</p>
              </div>
            ) : activePage ? (
              <>
                <div className="reader-toolbar">
                  <div className="reader-toolbar-left">
                    <a href="#/library" className="icon-ghost-btn" aria-label="返回書庫">
                      <ArrowLeft size={15} />
                    </a>
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
                    <span className="topic-pill">
                      <Tag size={12} aria-hidden="true" />
                      <bdi>{activePage.topic}</bdi>
                    </span>
                    {activePage.tags.map((tag) => (
                      <span key={tag} className="mini-tag">
                        <bdi>{tag}</bdi>
                      </span>
                    ))}
                  </div>

                  <div className="reader-toolbar-right">
                    <button
                      type="button"
                      className="btn-secondary is-compact"
                      onClick={() => setReadingFont((f) => (f === "sans" ? "serif" : "sans"))}
                      title="切換正文字體（現代黑體／書卷襯線）"
                    >
                      <Type size={13} aria-hidden="true" />
                      <span>{readingFont === "sans" ? "書卷襯線" : "現代黑體"}</span>
                    </button>

                    {activePage.annotations.length > 0 ? (
                      <button
                        type="button"
                        className="btn-secondary is-compact"
                        onClick={() => setShowInk((v) => !v)}
                        aria-pressed={showInk}
                      >
                        {showInk ? <EyeOff size={14} /> : <Eye size={14} />}
                        <span>{showInk ? "隱藏筆跡" : "顯示筆跡"}</span>
                      </button>
                    ) : null}

                    {pageToExplainHref ? (
                      <a href={pageToExplainHref} className="btn-explain-chip">
                        <AudioLines size={14} aria-hidden="true" />
                        <span>送到 Explain</span>
                      </a>
                    ) : null}

                    {pageToPersonalHref ? (
                      <a href={pageToPersonalHref} className="btn-personal-chip">
                        <CheckSquare size={14} aria-hidden="true" />
                        <span>待辦</span>
                      </a>
                    ) : null}

                    {activePage.annotatedAt ? (
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={annotating}
                        onClick={handleAnnotatePage}
                        title="重新執行 AI 塗鴉標註（保留手寫批註）"
                      >
                        <RefreshCw size={14} className={annotating ? "spin" : ""} />
                        <span>{annotating ? "標註中…" : `已存 ${activePage.annotations.length} 則 · 重跑`}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={annotating}
                        onClick={handleAnnotatePage}
                      >
                        <Sparkles size={14} className={annotating ? "spin" : ""} />
                        <span>{annotating ? "AI 正在畫重點…" : "AI 塗鴉標註"}</span>
                      </button>
                    )}

                    <button
                      type="button"
                      className="icon-ghost-btn is-danger"
                      aria-label="刪除此頁面"
                      title="刪除此保存頁面"
                      onClick={async () => {
                        await apiWrite("DELETE", `/api/pages/${encodeURIComponent(activePage.id)}`);
                        await loadLibrary();
                        window.location.hash = "#/library";
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>

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
                    <bdi>{activePage.title}</bdi>
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
                  page={activePage}
                  showInk={showInk}
                  readingFont={readingFont}
                  explainOrigin={explainOrigin}
                  selectionBusy={selectionBusy}
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
                />
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
                  <option value="api">OpenAI 相容 API（AI_API_KEY）</option>
                </select>
              </label>

              <label className="field-block">
                <span>指定模型（選填，留空使用預設）</span>
                <input
                  type="text"
                  value={settings.model}
                  onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
                  placeholder="例如 gpt-5 / claude-sonnet-4-5"
                />
              </label>

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
