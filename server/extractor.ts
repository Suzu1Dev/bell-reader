import { spawn } from "node:child_process";
import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { Agent, fetch as safeFetch } from "undici";
import ipaddr from "ipaddr.js";
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { ReaderBlock } from "../shared/types.js";
import { AppError } from "./errors.js";

const MAX_BYTES = 1_500_000;
export const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_BLOCKS = 400;
const MAX_BLOCK_CHARS = 2400;

export function isPublicAddress(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    }
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

export function validatePublicUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new AppError(400, "請輸入完整的 HTTPS 網址。");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".ts.net") ||
    (isIP(host) && !isPublicAddress(host))
  ) {
    throw new AppError(400, "只支援公開的 HTTPS 網址，無法讀取本機或內部網路。");
  }
  url.hash = "";
  if (url.href.length > 4000) {
    throw new AppError(400, "網址過長，請直接貼上內容。");
  }
  return url;
}

function safeImageUrl(raw: string | undefined, baseUrl: URL): string | undefined {
  if (!raw) return undefined;
  try {
    const resolved = new URL(raw, baseUrl);
    return validatePublicUrl(resolved.href).href;
  } catch {
    return undefined;
  }
}

export interface PublicFetchDeps {
  lookup?: (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;
  fetch?: typeof safeFetch;
}

export function createPinnedLookup(addresses: LookupAddress[]) {
  return (
    _host: string,
    options: LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    const reqFamily = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
    const matching = reqFamily
      ? addresses.filter((item) => item.family === reqFamily)
      : addresses;
    const selected = matching[0];
    if (!selected) {
      callback(new Error("No public address"), "", 4);
      return;
    }
    if (options.all) callback(null, matching);
    else callback(null, selected.address, selected.family);
  };
}

async function fetchPublicResource(
  input: string,
  signal: AbortSignal,
  opts: {
    accept: string;
    contentTypePattern: RegExp;
    invalidTypeError: string;
    maxBytes: number | ((contentType: string, url: URL) => number);
    sizeError: string | ((maxBytes: number) => string);
    timeoutMs: number;
  },
  deps?: PublicFetchDeps,
): Promise<{ buffer: Buffer; finalUrl: URL; contentType: string }> {
  let url = validatePublicUrl(input);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs)]);
  const doFetch = deps?.fetch ?? safeFetch;

  for (let redirects = 0; redirects <= 3; redirects++) {
    timeout.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = deps?.lookup
      ? await deps.lookup(hostname, { all: true })
      : await lookup(hostname, { all: true });
    timeout.throwIfAborted();
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
      throw new AppError(400, "此網址解析到非公開網路，無法讀取。");
    }
    const dispatcher = new Agent({
      connect: {
        timeout: 7000,
        lookup: createPinnedLookup(addresses),
      },
    });
    try {
      const response = await doFetch(url, {
        dispatcher,
        signal: timeout,
        redirect: "manual",
        headers: {
          "user-agent": "BELL-Web-Reader/0.1 (local personal study reader)",
          accept: opts.accept,
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === 3) {
          throw new AppError(422, "重新導向次數過多。");
        }
        url = validatePublicUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(
          response.status === 404 ? 404 : 422,
          response.status === 404 ? "找不到此網頁，請確認網址。" : "來源網站拒絕讀取，可直接貼上文字內容。",
        );
      }
      const contentType = response.headers.get("content-type") || "";
      if (!opts.contentTypePattern.test(contentType)) {
        await response.body?.cancel();
        throw new AppError(422, opts.invalidTypeError);
      }
      const maxBytes = typeof opts.maxBytes === "function" ? opts.maxBytes(contentType, url) : opts.maxBytes;
      const sizeError = typeof opts.sizeError === "function" ? opts.sizeError(maxBytes) : opts.sizeError;
      if (Number(response.headers.get("content-length") || 0) > maxBytes) {
        await response.body?.cancel();
        throw new AppError(413, sizeError);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AppError(422, "無法讀取遠端內容。");
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new AppError(413, sizeError);
        }
        chunks.push(value);
      }
      return { buffer: Buffer.concat(chunks), finalUrl: url, contentType };
    } finally {
      await dispatcher.close();
    }
  }
  throw new AppError(422, "無法讀取遠端內容。");
}

export async function fetchPublicHtml(
  input: string,
  signal: AbortSignal,
): Promise<{ html: string; finalUrl: URL; contentType: string }> {
  const { buffer, finalUrl, contentType } = await fetchPublicResource(input, signal, {
    accept: "text/html,text/plain,text/markdown;q=0.9,application/xhtml+xml;q=0.9",
    contentTypePattern: /text\/|application\/(xhtml\+xml|xml|json)/i,
    invalidTypeError: "此網址不是可閱讀的文字網頁，請直接貼上內容。",
    maxBytes: MAX_BYTES,
    sizeError: "網頁超過 1.5 MB 上限，請直接貼上想讀的段落。",
    timeoutMs: 12_000,
  });
  return { html: buffer.toString("utf8"), finalUrl, contentType };
}

export type PublicPageSource =
  | { kind: "html"; html: string; finalUrl: URL; contentType: string }
  | { kind: "pdf"; bytes: Buffer; finalUrl: URL; contentType: string };

export function hasPdfMagicHeader(bytes: Buffer): boolean {
  return bytes.subarray(0, 1024).toString("latin1").includes("%PDF-");
}

function isPdfMimeOrUrl(contentType: string, url: URL): boolean {
  if (/^application\/pdf\b/i.test(contentType)) return true;
  return /^application\/octet-stream\b/i.test(contentType) && url.pathname.toLowerCase().endsWith(".pdf");
}

export async function fetchPublicPageSource(
  input: string,
  signal: AbortSignal,
  deps?: PublicFetchDeps,
): Promise<PublicPageSource> {
  const { buffer, finalUrl, contentType } = await fetchPublicResource(
    input,
    signal,
    {
      accept: "text/html,text/plain,text/markdown;q=0.9,application/xhtml+xml;q=0.9,application/pdf;q=0.9",
      contentTypePattern: /text\/|application\/(xhtml\+xml|xml|json|pdf|octet-stream)/i,
      invalidTypeError: "此網址不是可閱讀的文字網頁或 PDF 文件，請直接貼上內容。",
      maxBytes: (ct, u) => (isPdfMimeOrUrl(ct, u) ? MAX_PDF_BYTES : MAX_BYTES),
      sizeError: (max) =>
        max >= MAX_PDF_BYTES
          ? "PDF 檔案超過 15 MB 上限，無法擷取。"
          : "網頁超過 1.5 MB 上限，請直接貼上想讀的段落。",
      timeoutMs: 18_000,
    },
    deps,
  );

  if (isPdfMimeOrUrl(contentType, finalUrl)) {
    if (!hasPdfMagicHeader(buffer)) {
      throw new AppError(422, "遠端檔案不是有效的 PDF 格式（缺少 %PDF- 檔頭）。");
    }
    return { kind: "pdf", bytes: buffer, finalUrl, contentType };
  }

  if (/^application\/octet-stream\b/i.test(contentType)) {
    if (hasPdfMagicHeader(buffer)) {
      return { kind: "pdf", bytes: buffer, finalUrl, contentType };
    }
    throw new AppError(422, "此網址回傳二進位檔案，非可閱讀網頁或 PDF。");
  }

  return { kind: "html", html: buffer.toString("utf8"), finalUrl, contentType };
}

export interface FetchedImage {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  ext: "png" | "jpg" | "webp" | "gif";
}

export async function fetchPublicImage(input: string, signal: AbortSignal): Promise<FetchedImage> {
  const { buffer, contentType } = await fetchPublicResource(input, signal, {
    accept: "image/png,image/jpeg,image/webp,image/gif;q=0.9,*/*;q=0.5",
    contentTypePattern: /^image\/(png|jpe?g|webp|gif)\b/i,
    invalidTypeError: "不支援的圖片格式。",
    maxBytes: 3_000_000,
    sizeError: "圖片超過 3 MB 上限。",
    timeoutMs: 8_000,
  });
  const lower = contentType.toLowerCase();
  if (lower.includes("png")) return { bytes: buffer, mimeType: "image/png", ext: "png" };
  if (lower.includes("webp")) return { bytes: buffer, mimeType: "image/webp", ext: "webp" };
  if (lower.includes("gif")) return { bytes: buffer, mimeType: "image/gif", ext: "gif" };
  return { bytes: buffer, mimeType: "image/jpeg", ext: "jpg" };
}

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_BLOCK_CHARS);
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

const TABLE_DIVIDER_RE = /^\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?$/;

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed
    .split(/(?<!\\)\|/)
    .map((cell) => normalizeInline(stripInlineMarkdown(cell.replace(/\\\|/g, "|"))));
}

function normalizeTableRows(rawRows: string[][]): string[][] {
  const colCount = rawRows.reduce((max, r) => Math.max(max, r.length), 0);
  if (colCount === 0) return [];
  return rawRows.map((row) =>
    Array.from({ length: colCount }, (_, idx) => row[idx] ?? ""),
  );
}

function isMarkdownTableAt(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  const header = lines[index].trim();
  const divider = lines[index + 1].trim();
  return header.includes("|") && TABLE_DIVIDER_RE.test(divider);
}

export interface ExtractedPage {
  title: string;
  siteName?: string;
  excerpt: string;
  blocks: ReaderBlock[];
}

export function extractBlocksFromHtml(html: string, pageUrl: URL, contentType = "text/html"): ExtractedPage {
  if (/text\/(plain|markdown)/i.test(contentType)) {
    return parsePastedContent(html, pageUrl.hostname);
  }
  const $ = cheerio.load(html);
  const rawTitle =
    normalizeInline($('meta[property="og:title"]').attr("content") || "") ||
    normalizeInline($("article h1, main h1, h1").first().text()) ||
    normalizeInline($("title").first().text()) ||
    pageUrl.hostname;
  const siteName =
    normalizeInline($('meta[property="og:site_name"]').attr("content") || "") || pageUrl.hostname;

  $(
    "script, style, noscript, iframe, svg, canvas, form, nav, footer, aside, dialog, [role='navigation'], [role='banner'], [role='contentinfo'], [aria-hidden='true']",
  ).remove();

  let root = $("article").first();
  if (!root.length || root.text().trim().length < 160) root = $("main, [role='main']").first();
  if (!root.length || root.text().trim().length < 120) root = $("body").first();

  const blocks: ReaderBlock[] = [];
  const seen = new Set<string>();
  const pushBlock = (block: Omit<ReaderBlock, "id">) => {
    if (blocks.length >= MAX_BLOCKS) return;
    const dedupeKey = `${block.kind}:${block.text || block.imageUrl || ""}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    blocks.push({ id: `b${blocks.length + 1}`, ...block });
  };

  const walk = (node: AnyNode) => {
    if (blocks.length >= MAX_BLOCKS || node.type !== "tag") return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") {
      const text = normalizeInline($(el).text());
      if (text && text !== rawTitle) {
        const level = tag === "h1" ? 1 : tag === "h2" ? 2 : 3;
        pushBlock({ kind: "heading", text, level });
      }
      return;
    }
    if (tag === "pre") {
      const codeEl = $(el).find("code").first();
      const rawCode = (codeEl.length ? codeEl.text() : $(el).text())
        .replace(/\r\n?/g, "\n")
        .replace(/^\n+|\n+$/g, "")
        .slice(0, MAX_BLOCK_CHARS);
      if (rawCode.trim()) {
        const cls = codeEl.attr("class") || $(el).attr("class") || "";
        const langMatch = /language-([a-z0-9_+-]+)/i.exec(cls);
        pushBlock({ kind: "code", text: rawCode, ...(langMatch ? { language: langMatch[1] } : {}) });
      }
      return;
    }
    if (tag === "blockquote") {
      const text = normalizeInline($(el).text());
      if (text.length >= 8) pushBlock({ kind: "quote", text });
      return;
    }
    if (tag === "ul" || tag === "ol") {
      $(el)
        .children("li")
        .each((_, li) => {
          const text = normalizeInline($(li).clone().children("ul, ol").remove().end().text());
          if (text.length >= 4) pushBlock({ kind: "list", text });
        });
      return;
    }
    if (tag === "table") {
      const rawRows: string[][] = [];
      $(el)
        .find("tr")
        .each((_, tr) => {
          const cells: string[] = [];
          $(tr)
            .children("th, td")
            .each((__, cell) => {
              cells.push(normalizeInline($(cell).text()));
            });
          if (cells.some((c) => c.length > 0)) {
            rawRows.push(cells);
          }
        });
      const rows = normalizeTableRows(rawRows);
      if (rows.length > 0) {
        pushBlock({
          kind: "table",
          text: rows.map((r) => r.join(" | ")).join("\n"),
          tableRows: rows,
        });
      }
      return;
    }
    if (tag === "img") {
      const src = safeImageUrl($(el).attr("src") || $(el).attr("data-src"), pageUrl);
      const alt = normalizeInline($(el).attr("alt") || "");
      const width = Number($(el).attr("width") || 400);
      if (src && width >= 120) {
        pushBlock({ kind: "image", text: alt || "文章附圖", imageUrl: src, ...(alt ? { alt } : {}) });
      }
      return;
    }
    if (tag === "p") {
      const img = $(el).find("img").first();
      if (img.length && !normalizeInline($(el).text())) {
        walk(img[0]);
        return;
      }
      const text = normalizeInline($(el).text());
      if (text.length >= 12) pushBlock({ kind: "paragraph", text });
      return;
    }

    $(el)
      .contents()
      .each((_, child) => walk(child));
  };

  root.contents().each((_, child) => walk(child));

  if (!blocks.length) {
    const rawCandidate = ($("#publish-page, #doc").first().text() || root.text()).replace(/\r\n?/g, "\n").trim();
    if (rawCandidate.includes("\n") && /^(?:#{1,3}\s+|```|!\[[^\]]*\]\(https?:\/\/|[-*+]\s+|\$\$)/m.test(rawCandidate)) {
      const cleanTitle = rawTitle.replace(/\s+-\s+HackMD$/i, "").trim();
      return parsePastedContent(rawCandidate, cleanTitle, siteName.slice(0, 60));
    }
    const fallback = normalizeInline(root.text());
    if (!fallback) throw new AppError(422, "無法從此網頁擷取正文（可能是純動態渲染網站），請直接貼上文字內容。");
    pushBlock({ kind: "paragraph", text: fallback });
  }

  const firstProse = blocks.find((b) => b.kind === "paragraph" || b.kind === "quote" || b.kind === "list");
  const excerpt = (firstProse?.text || blocks[0].text).slice(0, 160);
  return {
    title: rawTitle.slice(0, 120),
    siteName: siteName.slice(0, 60),
    excerpt,
    blocks,
  };
}

export function parsePastedContent(raw: string, explicitTitle?: string, siteName?: string): ExtractedPage {
  const cleaned = raw.replace(/\r\n?/g, "\n").trim();
  if (!cleaned) throw new AppError(400, "請輸入網址或貼上想閱讀的內容。");

  const lines = cleaned.split("\n");
  const blocks: ReaderBlock[] = [];
  let inferredTitle = explicitTitle?.trim() || "";

  const push = (block: Omit<ReaderBlock, "id">) => {
    if (blocks.length >= MAX_BLOCKS || !block.text.trim()) return;
    blocks.push({ id: `b${blocks.length + 1}`, ...block, text: block.text.slice(0, MAX_BLOCK_CHARS) });
  };

  let i = 0;
  while (i < lines.length && blocks.length < MAX_BLOCKS) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    if (isMarkdownTableAt(lines, i)) {
      const rawRows = [splitMarkdownTableRow(lines[i])];
      i += 2; // Skip header and separator line
      while (i < lines.length) {
        const rowLine = lines[i].trim();
        if (!rowLine || /^(```|\$\$|#{1,4}\s+)/.test(rowLine) || !rowLine.includes("|")) break;
        rawRows.push(splitMarkdownTableRow(lines[i]));
        i++;
      }
      const rows = normalizeTableRows(rawRows);
      if (rows.length > 0) {
        push({
          kind: "table",
          text: rows.map((r) => r.join(" | ")).join("\n"),
          tableRows: rows,
        });
      }
      continue;
    }
    const fence = /^```([a-z0-9_+-]*)\s*$/i.exec(trimmed);
    if (fence) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      push({ kind: "code", text: codeLines.join("\n"), ...(fence[1] ? { language: fence[1] } : {}) });
      continue;
    }
    if (trimmed === "$$") {
      const mathLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "$$") {
        mathLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      push({ kind: "code", language: "math", text: mathLines.join("\n").trim() });
      continue;
    }
    const imgMatch = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)\s*$/.exec(trimmed);
    if (imgMatch) {
      const alt = normalizeInline(imgMatch[1]);
      try {
        const src = validatePublicUrl(imgMatch[2]).href;
        push({ kind: "image", text: alt || "文章附圖", imageUrl: src, ...(alt ? { alt } : {}) });
      } catch {
        // Skip invalid/private image URLs
      }
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(3, heading[1].length) as 1 | 2 | 3;
      const text = stripInlineMarkdown(heading[2].trim());
      if (level === 1 && blocks.length === 0 && (!inferredTitle || inferredTitle === text)) {
        inferredTitle = text;
      } else {
        push({ kind: "heading", text, level });
      }
      i++;
      continue;
    }
    if (/^>\s*/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s*/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s*/, ""));
        i++;
      }
      push({ kind: "quote", text: normalizeInline(stripInlineMarkdown(quoteLines.join(" "))) });
      continue;
    }
    if (/^([-*+]|\d+\.)\s+/.test(trimmed)) {
      push({
        kind: "list",
        text: normalizeInline(stripInlineMarkdown(trimmed.replace(/^([-*+]|\d+\.)\s+/, ""))),
      });
      i++;
      continue;
    }
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isMarkdownTableAt(lines, i) &&
      !/^(```|\$\$|#{1,4}\s+|>\s*|([-*+]|\d+\.)\s+|!\[[^\]]*\]\(https?:\/\/)/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    push({ kind: "paragraph", text: normalizeInline(stripInlineMarkdown(paraLines.join(" "))) });
  }

  if (!blocks.length) {
    blocks.push({ id: "b1", kind: "paragraph", text: cleaned.slice(0, MAX_BLOCK_CHARS) });
  }
  const title = (inferredTitle || blocks[0].text.slice(0, 42)).slice(0, 120);
  const firstProse = blocks.find((b) => b.kind !== "heading") ?? blocks[0];
  return {
    title,
    ...(siteName ? { siteName } : {}),
    excerpt: firstProse.text.slice(0, 160),
    blocks,
  };
}

/**
 * Resolves a quote inside a block's text to exact character offsets [startOffset, endOffset].
 * Falls back to collapsed-whitespace matching if AI slightly normalized spaces.
 */
export function resolveQuoteAnchor(
  blockText: string,
  quote: string,
): { startOffset: number; endOffset: number; exactQuote: string } | undefined {
  const trimmed = quote.trim();
  if (!trimmed || !blockText) return undefined;
  const direct = blockText.indexOf(trimmed);
  if (direct >= 0) {
    return {
      startOffset: direct,
      endOffset: direct + trimmed.length,
      exactQuote: blockText.slice(direct, direct + trimmed.length),
    };
  }
  // Collapsed whitespace fallback
  const tokens = trimmed.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (tokens.length > 1) {
    const regex = new RegExp(tokens.join("\\s+"));
    const match = regex.exec(blockText);
    if (match && match[0]) {
      return {
        startOffset: match.index,
        endOffset: match.index + match[0].length,
        exactQuote: match[0],
      };
    }
  }
  return undefined;
}

function unescapePdfLiteral(raw: string): string {
  return raw
    .replace(/\\([nrtbf()\\])/g, (_, ch: string) => {
      if (ch === "n") return "\n";
      if (ch === "r") return "\r";
      if (ch === "t") return "\t";
      if (ch === "b") return "\b";
      if (ch === "f") return "\f";
      return ch;
    })
    .replace(/\\([0-7]{1,3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

function extractPdfOperators(content: string): string {
  const parts: string[] = [];
  const tjRe = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  const arrRe = /\[((?:[^[\]]|\((?:\\.|[^\\)])*\))*)\]\s*TJ/g;
  const tokens: Array<{ idx: number; text: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = tjRe.exec(content))) {
    tokens.push({ idx: m.index, text: unescapePdfLiteral(m[1]) });
  }
  while ((m = arrRe.exec(content))) {
    const inner = m[1];
    let str = "";
    const litRe = /\(((?:\\.|[^\\)])*)\)/g;
    let lm: RegExpExecArray | null;
    while ((lm = litRe.exec(inner))) {
      str += unescapePdfLiteral(lm[1]);
    }
    if (str) tokens.push({ idx: m.index, text: str });
  }
  tokens.sort((a, b) => a.idx - b.idx);
  for (const tok of tokens) {
    parts.push(tok.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function extractPdfTextFallbackJs(bytes: Buffer): { pages: string[]; pageCount: number } {
  const latin = bytes.toString("latin1");
  const pageMatches = latin.match(/\/Type\s*\/Page\b/g);
  const pageCount = Math.max(1, pageMatches ? pageMatches.length : 1);
  const extracted: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(latin))) {
    const rawChunk = Buffer.from(match[1], "latin1");
    let textStream = match[1];
    try {
      textStream = inflateSync(rawChunk, { maxOutputLength: MAX_PDF_BYTES * 2 }).toString("latin1");
    } catch {
      // Uncompressed or different filter; inspect rawChunk directly
    }
    const opText = extractPdfOperators(textStream);
    if (opText) extracted.push(opText);
  }
  if (!extracted.length) {
    const directOps = extractPdfOperators(latin);
    if (directOps) extracted.push(directOps);
  }
  return { pages: extracted.length ? [extracted.join("\n\n")] : [], pageCount };
}

async function runGhostscriptTxtWrite(bytes: Buffer): Promise<{ pages: string[]; pageCount: number } | null> {
  const dir = await mkdtemp(join(tmpdir(), "bell-reader-pdf-"));
  const pdfPath = join(dir, "input.pdf");
  try {
    await writeFile(pdfPath, bytes);
    const gsBin = process.env.GS_BIN || "/usr/bin/gs";
    const result = await new Promise<{ code: number | null; stderr: string; error?: Error }>((resolve) => {
      const child = spawn(
        gsBin,
        ["-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=txtwrite", "-dTextFormat=3", `-o${dir}/p-%04d.txt`, pdfPath],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 4000) stderr += chunk;
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: null, stderr, error: err });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
    });

    if (/requires a password|password/i.test(result.stderr)) {
      throw new AppError(422, "此 PDF 受密碼保護，請先解除加密後再上傳。");
    }
    if (result.error || result.code !== 0) {
      return null;
    }

    const files = (await readdir(dir)).filter((f) => /^p-\d+\.txt$/.test(f)).sort();
    if (!files.length) return null;
    const pages: string[] = [];
    for (const file of files) {
      pages.push(await readFile(join(dir, file), "utf8"));
    }
    return { pages, pageCount: files.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function extractBlocksFromPdf(
  bytes: Buffer,
  filenameOrTitle = "PDF 文件",
): Promise<ExtractedPage & { pageCount: number }> {
  if (!hasPdfMagicHeader(bytes)) {
    throw new AppError(422, "檔案不是有效的 PDF 格式（缺少 %PDF- 檔頭）。");
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new AppError(413, "PDF 檔案超過 15 MB 上限。");
  }

  // shortcut: gs txtwrite interleaves multi-column PDFs and omits native /Outlines; upgrade to pdfjs-dist if needed
  const gsResult = await runGhostscriptTxtWrite(bytes);
  const rawResult = gsResult ?? extractPdfTextFallbackJs(bytes);
  const pageCount = Math.max(1, rawResult.pageCount);

  const blocks: ReaderBlock[] = [];
  const pushBlock = (block: Omit<ReaderBlock, "id">) => {
    if (blocks.length >= MAX_BLOCKS || !block.text.trim()) return;
    blocks.push({ id: `b${blocks.length + 1}`, ...block, text: block.text.slice(0, MAX_BLOCK_CHARS) });
  };

  for (let pIdx = 0; pIdx < rawResult.pages.length && blocks.length < MAX_BLOCKS; pIdx++) {
    const normalized = rawResult.pages[pIdx]
      .normalize("NFKC")
      .replace(/\r\n?/g, "\n")
      .replace(/^\s*[—-]\s*\d+\s*[—-]\s*$/gm, "")
      .trim();
    if (!normalized) continue;

    if (pageCount > 1) {
      pushBlock({ kind: "heading", level: 2, text: `第 ${pIdx + 1} 頁` });
    }

    const chunks = normalized.split(/\n{2,}/);
    for (const chunk of chunks) {
      if (blocks.length >= MAX_BLOCKS) break;
      const lines = chunk
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) continue;

      const joined = lines.join(" ").replace(/\s+/g, " ").trim();
      if (!joined || /^\d{1,4}$/.test(joined)) continue;

      if (
        lines.length === 1 &&
        joined.length <= 72 &&
        (/^(?:\d+(?:\.\d+)*\s+\S+|第\s*[一二三四五六七八九十\d]+\s*[章節講課篇])/.test(joined) ||
          (joined.length <= 42 && !/[。！？.;]$/.test(joined) && !joined.includes("://")))
      ) {
        pushBlock({ kind: "heading", level: 3, text: joined });
        continue;
      }

      if (lines.every((l) => /^(?:[-*•·]|\d+[.)])\s+/.test(l))) {
        for (const item of lines) {
          pushBlock({ kind: "list", text: item.replace(/^(?:[-*•·]|\d+[.)])\s+/, "").trim() });
        }
        continue;
      }

      if (lines.length >= 2 && lines.some((l) => /[{}();]/.test(l)) && lines.filter((l) => /;\s*$/.test(l)).length >= 1) {
        pushBlock({ kind: "code", text: lines.join("\n") });
        continue;
      }

      pushBlock({ kind: "paragraph", text: joined });
    }
  }

  if (blocks.length === 0) {
    pushBlock({
      kind: "paragraph",
      text: "此 PDF 頁面僅含影像或掃描圖層，未擷取到可選取文字；請直接使用左側 PDF 原檔並排閱讀，並在右側記錄筆記。",
    });
  }

  const cleanFileTitle = filenameOrTitle.replace(/\.pdf$/i, "").trim();
  const firstHeading = blocks.find((b) => b.kind === "heading" && !/^第 \d+ 頁$/.test(b.text));
  const title = (cleanFileTitle && cleanFileTitle !== "document"
    ? cleanFileTitle
    : firstHeading?.text || blocks[0].text.slice(0, 48)
  ).slice(0, 120);
  const firstProse = blocks.find((b) => b.kind === "paragraph" || b.kind === "list") ?? blocks[0];
  return {
    title,
    siteName: "PDF 文件",
    excerpt: firstProse.text.slice(0, 160),
    blocks,
    pageCount,
  };
}
