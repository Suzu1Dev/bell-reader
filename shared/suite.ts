/**
 * suite-contract v1 (rev. f: adds "campaign" as the 5th BELL Suite product)
 */

export const SUITE_APP_IDS = ["explain", "personal", "pr", "reader", "campaign"] as const;
export type SuiteAppId = (typeof SUITE_APP_IDS)[number];
export type SuiteLinks = Partial<Record<SuiteAppId, string>>;

export const SUITE_LIMITS = {
  title: 120,
  detail: 80,
  id: 128,
  href: 512,
  items: 5,
  counts: 8,
  countMax: 100_000,
  capabilities: 16,
  displayName: 40,
  summary: 40,
  links: 5,
  handoffText: 2000,
  handoffTitle: 120,
  back: 512,
  fetchTimeoutMs: 3000,
  fetchMaxBytes: 64 * 1024,
  cacheFreshMs: 60_000,
  staleDropMs: 30 * 60_000,
} as const;

export const SUITE_OBJECT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HREF = /^#\/[A-Za-z0-9/_\-.~%:]*(?:\?[A-Za-z0-9_\-.~%=&+]*)?$/;
export const SUITE_UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_HANDOFF = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const SINGLE_HANDOFF_PARAMS = ["text", "title", "draft", "from", "back"] as const;

export const SUITE_ROUTES: Record<SuiteAppId, readonly string[]> = {
  explain: ["#/", "#/library", "#/graph", "#/favorites", "#/repositories", "#/review", "#/note/{id}"],
  personal: ["#/today", "#/tasks", "#/tasks/{id}", "#/events", "#/events/{id}", "#/ideas", "#/ideas/{id}", "#/inbox", "#/inbox/{id}"],
  pr: ["#/", "#/home", "#/demo", "#/repos", "#/repos/{id}", "#/discover", "#/team", "#/group", "#/learning", "#/settings", "#/runs/{id}"],
  reader: ["#/", "#/library", "#/topics", "#/page/{id}"],
  campaign: [
    "#/",
    "#/schedule",
    "#/tasks",
    "#/partners",
    "#/forms",
    "#/files",
    "#/meetings",
    "#/inspirations",
    "#/notes",
    "#/bot",
  ],
};

export interface SuiteCapability {
  id: string;
  kind: "accept-handoff" | "today-feed" | "object-route";
  route?: string;
  api?: string;
  accepts?: ["text"];
  maxChars?: number;
}

export interface SuiteManifest {
  schemaVersion: 1;
  appId: SuiteAppId;
  displayName: string;
  summary: string;
  capabilities: SuiteCapability[];
  links: SuiteLinks;
}

export interface SuiteTodayItem {
  sourceApp: SuiteAppId;
  type: string;
  id: string;
  title: string;
  href: string;
  state: "due" | "new" | "waiting" | "needs-you";
  updatedAt: string;
  dueAt?: string;
  detail?: string;
}

export interface SuiteTodayFeed {
  schemaVersion: 1;
  appId: SuiteAppId;
  generatedAt: string;
  counts: Record<string, number>;
  items: SuiteTodayItem[];
  truncated: boolean;
}

export function validSuiteHref(value: unknown, max: number = SUITE_LIMITS.href): value is string {
  if (typeof value !== "string" || value.length > max || !HREF.test(value)) return false;
  if (value.includes("//")) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return false;
  }
  return !SUITE_UNSAFE_TEXT.test(decoded) && !decoded.includes("\\") && !decoded.slice(2).startsWith("/");
}

export function allowedSuiteRoute(app: SuiteAppId, value: unknown, max: number = SUITE_LIMITS.href): value is string {
  if (!validSuiteHref(value, max)) return false;
  return SUITE_ROUTES[app].some((route) => {
    const at = route.indexOf("{id}");
    if (at < 0) return value === route;
    const id = value.slice(at);
    return value.startsWith(route.slice(0, at)) && SUITE_OBJECT_ID.test(id) && id !== "." && id !== "..";
  });
}

function loopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (bare === "::1" || bare === "localhost") return true;
  const parts = bare.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function tailnetOf(hostname: string): string | undefined {
  const labels = hostname.toLowerCase().split(".");
  return labels.length >= 4 && labels.at(-1) === "net" && labels.at(-2) === "ts" ? labels.slice(-3).join(".") : undefined;
}

export function safeSuiteOrigin(value: unknown, currentHostname = ""): string | undefined {
  if (typeof value !== "string" || !/^https?:\/\/[^/?#\\\s@*]+$/i.test(value) || value.endsWith(":")) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.port === "0") return undefined;
    if (loopbackHostname(url.hostname)) return url.origin;
    const tailnet = tailnetOf(url.hostname);
    if (url.protocol !== "https:" || !tailnet || tailnet !== tailnetOf(currentHostname)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export interface ReaderHandoffDraft {
  from: SuiteAppId;
  text: string;
  title?: string;
  truncated: boolean;
  backUrl?: string;
}

function cleanText(value: string, max: number): { text: string; truncated: boolean } {
  const cleaned = value.replace(/\r\n?/g, "\n").replace(UNSAFE_HANDOFF, "").trim();
  const chars = [...cleaned];
  return { text: chars.slice(0, max).join(""), truncated: chars.length > max };
}

export function isReaderHandoffAttempt(hash: string): boolean {
  const [path, query = ""] = String(hash).replace(/^#/, "").split("?", 2);
  if (path !== "/read" || !query) return false;
  const params = new URLSearchParams(query);
  return SINGLE_HANDOFF_PARAMS.some((key) => params.has(key));
}

export function parseReaderHandoff(
  hash: string,
  links: SuiteLinks,
): { present: false } | { present: true; draft?: ReaderHandoffDraft; rejected?: "duplicate" | "missing" | "from" | "empty" } {
  if (!isReaderHandoffAttempt(hash)) return { present: false };
  const [, query = ""] = String(hash).replace(/^#/, "").split("?", 2);
  const params = new URLSearchParams(query);
  if (SINGLE_HANDOFF_PARAMS.some((key) => params.getAll(key).length > 1)) {
    return { present: true, rejected: "duplicate" };
  }
  if (!params.has("text")) return { present: true, rejected: "missing" };
  const from = params.get("from") as SuiteAppId | null;
  if (!from || from === "reader" || !SUITE_APP_IDS.includes(from) || !links[from]) {
    return { present: true, rejected: "from" };
  }
  const body = cleanText(params.get("text") ?? "", SUITE_LIMITS.handoffText);
  if (!body.text) return { present: true, rejected: "empty" };
  const rawTitle = params.get("title");
  const title = rawTitle ? cleanText(rawTitle.replace(/[\r\n\t]/g, " "), SUITE_LIMITS.handoffTitle) : undefined;
  const back = params.get("back");
  const backUrl = back && allowedSuiteRoute(from, back, SUITE_LIMITS.back) ? `${links[from]}/${back}` : undefined;
  return {
    present: true,
    draft: {
      from,
      text: body.text,
      ...(title?.text ? { title: title.text } : {}),
      truncated: body.truncated || Boolean(title?.truncated),
      ...(backUrl ? { backUrl } : {}),
    },
  };
}

export function buildExplainHandoffText(page: {
  sourceKind: "url" | "paste" | "pdf";
  url?: string;
  siteName?: string;
  title: string;
  excerpt: string;
  topic?: string;
  summary?: string;
  hasPdf?: boolean;
  pdfPageCount?: number;
  blocks: Array<{ kind: string; text: string }>;
  annotations: Array<{ quote: string; note: string }>;
  interactiveBlocks?: Array<{ kind: string; title: string; summary?: string }>;
}): string {
  const isPdf = Boolean(page.hasPdf || page.sourceKind === "pdf");
  const sourceLabel = isPdf
    ? `PDF 文件（${Math.max(1, page.pdfPageCount ?? 1)} 頁）`
    : page.siteName?.trim() || "保存文章";
  const headerLines = [`來源：${sourceLabel}`];
  if (page.url?.trim()) headerLines.push(`網址：${page.url.trim()}`);
  if (page.topic?.trim() && page.topic.trim() !== "未分類") {
    headerLines.push(`主題：${page.topic.trim()}`);
  }

  let bodySection = "";
  const summary = page.summary?.trim();
  if (summary) {
    bodySection = `摘要：${summary}`;
  } else {
    const proseParts: string[] = [];
    const excerpt = page.excerpt?.trim();
    if (excerpt) proseParts.push(excerpt);
    let proseChars = excerpt ? [...excerpt].length : 0;
    for (const block of page.blocks) {
      if (block.kind === "heading" || block.kind === "image") continue;
      const text = block.text.trim();
      if (!text) continue;
      const chars = [...text];
      if (excerpt && (text.startsWith(excerpt) || excerpt.startsWith(chars.slice(0, 60).join("")))) continue;
      const sliceLen = Math.min(chars.length, 360);
      if (proseChars + sliceLen > 720 && proseParts.length > 0) break;
      proseParts.push(chars.slice(0, 360).join(""));
      proseChars += sliceLen;
      if (proseParts.length >= 4) break;
    }
    if (proseParts.length) bodySection = `內容節錄：\n${proseParts.join("\n")}`;
  }

  const notesDigest = page.annotations
    .slice(0, 4)
    .map((a) => `• 「${a.quote.trim()}」→ ${a.note.trim()}`)
    .join("\n");

  const interactiveDigest = (page.interactiveBlocks ?? [])
    .slice(0, 3)
    .map(
      (ib) =>
        `• [${ib.kind === "simulation" ? "互動模擬" : "概念步進"}] ${ib.title.trim()}${
          ib.summary?.trim() ? `：${ib.summary.trim()}` : ""
        }`,
    )
    .join("\n");

  const full = [
    headerLines.join("\n"),
    bodySection,
    notesDigest ? `重點標註：\n${notesDigest}` : "",
    interactiveDigest ? `互動區塊：\n${interactiveDigest}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return cleanText(full, SUITE_LIMITS.handoffText).text;
}

export function explainDraftHref(
  explainOrigin: string | undefined,
  input: { text: string; title?: string; back?: string; source?: string; url?: string; pdf?: string },
  currentHostname = "",
): string | undefined {
  const origin = safeSuiteOrigin(explainOrigin, currentHostname);
  const body = cleanText(input.text, SUITE_LIMITS.handoffText);
  if (!origin || !body.text) return undefined;
  const params = new URLSearchParams({ text: body.text, from: "reader" });
  if (input.title) {
    const cleanTitle = cleanText(input.title.replace(/[\r\n\t]/g, " "), SUITE_LIMITS.handoffTitle);
    if (cleanTitle.text) params.set("title", cleanTitle.text);
  }
  if (input.back && allowedSuiteRoute("reader", input.back, SUITE_LIMITS.back)) {
    params.set("back", input.back);
  }
  if (input.source) {
    const cleanSource = cleanText(input.source.replace(/[\r\n\t]/g, " "), 40);
    if (cleanSource.text) params.set("source", cleanSource.text);
  }
  if (input.url) {
    const trimmed = input.url.trim();
    if (/^https?:\/\/\S+$/i.test(trimmed)) {
      const cleanUrl = cleanText(trimmed, SUITE_LIMITS.href);
      if (cleanUrl.text) params.set("url", cleanUrl.text);
    }
  }
  if (input.pdf) {
    const cleanPdf = cleanText(input.pdf.replace(/[\r\n\t]/g, " "), SUITE_LIMITS.handoffTitle);
    if (cleanPdf.text) params.set("pdf", cleanPdf.text);
  }
  return `${origin}/#/explain?${params.toString()}`;
}

export function personalTaskHref(
  personalOrigin: string | undefined,
  draftText: string,
  back?: string,
  currentHostname = "",
): string | undefined {
  const origin = safeSuiteOrigin(personalOrigin, currentHostname);
  const body = cleanText(draftText, SUITE_LIMITS.handoffText);
  if (!origin || !body.text) return undefined;
  const params = new URLSearchParams({ draft: body.text, from: "reader" });
  if (back && allowedSuiteRoute("reader", back, SUITE_LIMITS.back)) {
    params.set("back", back);
  }
  return `${origin}/#/tasks?${params.toString()}`;
}

export function prDraftHref(
  prOrigin: string | undefined,
  input: { draft: string; title?: string; back?: string },
  currentHostname = "",
): string | undefined {
  const origin = safeSuiteOrigin(prOrigin, currentHostname);
  const body = cleanText(input.draft, SUITE_LIMITS.handoffText);
  if (!origin || !body.text) return undefined;
  const params = new URLSearchParams({ draft: body.text, from: "reader" });
  if (input.title) {
    const cleanTitle = cleanText(input.title.replace(/[\r\n\t]/g, " "), SUITE_LIMITS.handoffTitle);
    if (cleanTitle.text) params.set("title", cleanTitle.text);
  }
  if (input.back && allowedSuiteRoute("reader", input.back, SUITE_LIMITS.back)) {
    params.set("back", input.back);
  }
  return `${origin}/#/discover?${params.toString()}`;
}
