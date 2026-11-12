import { useEffect, useState } from "react";
import { AudioLines, Check, GitPullRequest, Highlighter, Search, Sun } from "lucide-react";
import { Command } from "cmdk";
import type { SuiteAppId, SuiteLinks } from "../../shared/suite";

const APPS: Array<{
  id: SuiteAppId;
  name: string;
  summary: string;
  icon: typeof Sun;
  shortcut: number;
}> = [
  { id: "personal", name: "BELL Personal", summary: "今日與收件匣", icon: Sun, shortcut: 1 },
  { id: "explain", name: "BELL Explain", summary: "理解與複習", icon: AudioLines, shortcut: 2 },
  { id: "pr", name: "BELL PR", summary: "貢獻與審查", icon: GitPullRequest, shortcut: 3 },
  { id: "reader", name: "BELL Web Reader", summary: "網頁閱讀與標註", icon: Highlighter, shortcut: 4 },
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
      if (["1", "2", "3", "4"].includes(event.key)) {
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
        <Search size={15} aria-hidden="true" />
        <Command.Input
          value={search}
          onValueChange={setSearch}
          aria-label="切換 BELL 產品"
          placeholder="前往產品…"
          autoFocus
        />
        <kbd>esc</kbd>
      </div>
      <Command.List className="p-command-list">
        <Command.Empty>沒有符合的產品</Command.Empty>
        {manifestError ? (
          <Command.Item
            value="無法載入產品清單 重試"
            onSelect={() => onRetry?.()}
            className="p-command-item"
          >
            <span className="p-command-app-name">
              <b>無法載入產品清單</b>
              <small>點擊重試</small>
            </span>
          </Command.Item>
        ) : (
          APPS.map((app) => {
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
                className="p-command-item"
                onSelect={() => {
                  if (href) window.location.href = `${href}/`;
                }}
              >
                <span className={`p-app-icon p-app-${app.id}`}>
                  <Icon size={15} aria-hidden="true" />
                </span>
                <span className="p-command-app-name">
                  <b>{app.name}</b>
                  <small>{app.summary}</small>
                </span>
                <span className="p-command-app-state">
                  {current ? (
                    <em>
                      目前 <Check size={12} aria-hidden="true" />
                    </em>
                  ) : !href ? (
                    <em>尚未連結</em>
                  ) : null}
                  <kbd>⌃{app.shortcut}</kbd>
                </span>
              </Command.Item>
            );
          })
        )}
      </Command.List>
    </Command.Dialog>
  );
}
