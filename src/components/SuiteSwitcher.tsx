import { useEffect, useState } from "react";
import { ArrowUpRight, AudioLines, CalendarRange, Check, GitPullRequest, Highlighter, Search, Sun } from "lucide-react";
import { Command } from "cmdk";
import type { SuiteAppId, SuiteLinks } from "../../shared/suite";

const APPS: Array<{
  id: SuiteAppId;
  name: string;
  summary: string;
  icon: typeof Sun;
  shortcut: number;
}> = [
  { id: "personal", name: "BELL Personal", summary: "今日任務、行事曆與收件匣", icon: Sun, shortcut: 1 },
  { id: "explain", name: "BELL Explain", summary: "深入概念拆解與間隔複習", icon: AudioLines, shortcut: 2 },
  { id: "pr", name: "BELL PR", summary: "開源貢獻與程式碼審查", icon: GitPullRequest, shortcut: 3 },
  { id: "reader", name: "BELL Web Reader", summary: "網頁擷取與紙上手寫塗鴉筆記", icon: Highlighter, shortcut: 4 },
  { id: "campaign", name: "BELL Campaign", summary: "活動專案倒數時程與團隊協作", icon: CalendarRange, shortcut: 5 },
];

export default function SuiteSwitcher({
  links,
  open,
  onOpenChange,
  manifestError,
  onRetry,
}: {
  links: SuiteLinks;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  manifestError?: boolean;
  onRetry?: () => void;
}) {
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
        return;
      }
      if (["1", "2", "3", "4", "5"].includes(event.key)) {
        event.preventDefault();
        const idx = Number(event.key) - 1;
        const target = APPS[idx];
        if (!target || target.id === "reader") {
          onOpenChange(true);
          return;
        }
        const href = links[target.id];
        if (href) window.location.href = `${href}/`;
        else onOpenChange(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [links, open, onOpenChange]);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="切換 BELL 產品"
      className="p-command"
      overlayClassName="p-command-overlay"
      contentClassName="p-command-content"
    >
      <div className="p-command-search">
        <Search size={15} className="p-command-search-icon" aria-hidden="true" />
        <Command.Input
          value={search}
          onValueChange={setSearch}
          aria-label="切換 BELL 產品"
          placeholder="切換到 BELL 工具…"
          autoFocus
        />
        <kbd className="p-kbd">ESC</kbd>
      </div>
      <Command.List className="p-command-list">
        <Command.Empty className="p-command-empty">沒有符合的 BELL 產品</Command.Empty>
        {manifestError ? (
          <Command.Item
            value="無法載入產品清單 重試"
            onSelect={() => onRetry?.()}
            className="p-command-item"
          >
            <div className="p-command-app-meta">
              <span className="p-command-app-name">無法載入產品清單</span>
              <span className="p-command-app-summary">點擊重新連線套件清單</span>
            </div>
          </Command.Item>
        ) : (
          <Command.Group heading="BELL 產品套件" className="p-command-group">
            {APPS.map((app) => {
              const Icon = app.icon;
              const current = app.id === "reader";
              const href = current ? undefined : links[app.id];
              const disabled = current || !href;
              return (
                <Command.Item
                  key={app.id}
                  value={`${app.name} ${app.summary}`}
                  disabled={disabled}
                  aria-current={current ? "page" : undefined}
                  className={`p-command-item ${current ? "is-current" : !href ? "is-unlinked" : ""}`}
                  onSelect={() => {
                    if (href) window.location.href = `${href}/`;
                  }}
                >
                  <span className={`p-app-icon p-app-${app.id}`} aria-hidden="true">
                    <Icon size={16} />
                  </span>
                  <div className="p-command-app-meta">
                    <span className="p-command-app-name">{app.name}</span>
                    <span className="p-command-app-summary">{app.summary}</span>
                  </div>
                  <div className="p-command-app-state">
                    {current ? (
                      <span className="p-state-current">
                        <Check size={12} aria-hidden="true" />
                        <span>目前</span>
                      </span>
                    ) : href ? (
                      <ArrowUpRight size={14} className="p-state-arrow" aria-hidden="true" />
                    ) : (
                      <span className="p-state-unlinked">尚未連結</span>
                    )}
                    <kbd className="p-kbd">⌃{app.shortcut}</kbd>
                  </div>
                </Command.Item>
              );
            })}
          </Command.Group>
        )}
      </Command.List>
      <div className="p-command-footer" aria-hidden="true">
        <span>↑↓ 選擇</span>
        <span>Enter 開啟</span>
        <span>⌃1–5 快速切換</span>
      </div>
    </Command.Dialog>
  );
}
