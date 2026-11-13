# BELL Web Reader

[English](./README.md) · **繁體中文**

本機優先的網頁擷取與紙上手繪塗鴉標註閱讀器：擷取公開 HTTPS 文章或貼上 Markdown／文字為離線閱讀快照，疊加有機手繪螢光筆、波浪線、圈選框與頁邊批註卡。可單獨執行（Standalone Edition），也可與 [BELL Suite](https://github.com/Suzu1Dev/bell-suite)（Personal、Explain、PR、Campaign）串聯運作。

## 一鍵安裝與 CLI 啟動

```bash
# macOS / Linux / WSL
curl -fsSL https://raw.githubusercontent.com/Suzu1Dev/bell-reader/main/install.sh | sh
bell-reader

# 或直接透過 npx 啟動
npx bell-reader
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Suzu1Dev/bell-reader/main/install.ps1 | iex
bell-reader
```

常用 CLI 指令：

```bash
bell-reader start               # 獨立模式啟動（預設 http://127.0.0.1:4630）
bell-reader start --suite       # BELL Suite 模式啟動（預設 http://127.0.0.1:4604）
bell-reader doctor              # 檢查 Node、SQLite、資料目錄與選用 AI CLI 狀態
```

## 核心設計

1. **乾淨閱讀快照 ＋ 動態錨點 SVG 塗鴉層**：
   - 後端以 SSRF 防護（DNS 釘定公開 IP、禁止內網與重新導向濫用）擷取公開 HTTPS 網頁正文、程式碼與附圖，或直接解析貼上的文章／Markdown，離線保存於本機 SQLite（`data/bell-reader.sqlite`）。
   - 前端不破壞內容排版，以 `Range.getClientRects()` 綁定精確文字範圍，即時疊加有機手繪 SVG 圖層（螢光筆 `highlight`、波浪線 `underline`、圈選框 `box`、段落括號 `bracket`）與跨欄手繪曲線箭頭，連至右側手寫風格頁邊批註卡。
2. **保存即快取，不重複燒 Token**：
   - 已讀取的網址再次輸入時直接載入本機快照與既有標註；重新開啟頁面 0 AI 呼叫。
   - 支援整頁一鍵「AI 塗鴉標註」、雙語翻譯、選取單句「AI 說明」或 0 Token「手寫批註」。
3. **資料夾歸納 ＋ BELL Suite 雙向交接**：
   - 支援將頁面與批註透過 Suite 契約送到 **BELL Explain**（`#/explain`）、**BELL Personal**（`#/tasks`）或 **BELL PR**（`#/discover`），並接收來自姊妹應用的 `#/read?text=...` 閱讀交接。

## 開發與測試

```bash
npm install
npm run dev
npm test
npm run build
```

## 授權

[Apache-2.0](./LICENSE) · [Trademarks](./TRADEMARKS.md)
