# BELL Web Reader

BELL Suite 第四款工具：網頁與內容閱讀、手繪塗鴉疊加標註、資料夾／主題自動歸納，以及與 **BELL Explain** 的雙向知識連通。

## 核心設計

1. **乾淨閱讀快照 ＋ 動態錨點 SVG 塗鴉層**：
   - 後端以 SSRF 防護（DNS 釘定公開 IP、禁止內網與重新導向濫用）擷取公開 HTTPS 網頁正文、程式碼與附圖，或直接解析貼上的文章／Markdown，離線保存於本機 SQLite（`data/bell-reader.sqlite`）。
   - 前端不破壞內容排版，以 `Range.getClientRects()` 綁定精確文字範圍，即時疊加有機手繪 SVG 圖層（螢光筆 `highlight`、波浪線 `underline`、圈選框 `box`、段落括號 `bracket`）與跨欄手繪曲線箭頭，連至右側手寫風格頁邊批註卡（視窗縮放自動重算，360px 窄螢幕自動轉為段落下方眉批卡）。
2. **保存即快取，不重複燒 Token**：
   - 已讀取的網址再次輸入時直接載入本機快照與既有標註；重新開啟頁面 0 AI 呼叫。
   - 支援整頁一鍵「AI 塗鴉標註」，也支援選取單句「AI 說明」或 0 Token「手寫批註」。
3. **資料夾歸納 ＋ 自動主題判斷 ＋ BELL Explain 連通**：
   - AI 標註時自動判斷頁面 `topic` 與 `tags`，並可自動歸入對應主題資料夾。
   - 透過本機 loopback 唯讀比對 BELL Explain 筆記主題，在頁面頂端與「主題歸納」頁直接顯示相關 Explain 筆記晶片，並支援將整頁或單則批註以 Suite 交接格式（`#/explain?text=…&from=reader&back=#/page/{id}`）送到 Explain 深入學習。

## 啟動與測試

```bash
npm run typecheck
npm test
npm run build
npm start
```
