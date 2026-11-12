import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as safeFetch } from "undici";
import ipaddr from "ipaddr.js";
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { ReaderBlock } from "../shared/types.js";
import { AppError } from "./errors.js";

const MAX_BYTES = 1_500_000;
const MAX_BLOCKS = 120;
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

export async function fetchPublicHtml(
  input: string,
  signal: AbortSignal,
): Promise<{ html: string; finalUrl: URL; contentType: string }> {
  let url = validatePublicUrl(input);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);

  for (let redirects = 0; redirects <= 3; redirects++) {
    timeout.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await lookup(hostname, { all: true });
    timeout.throwIfAborted();
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
      throw new AppError(400, "此網址解析到非公開網路，無法讀取。");
    }
    const dispatcher = new Agent({
      connect: {
        timeout: 7000,
        lookup: (_host, options, callback) => {
          const matching = options.family
            ? addresses.filter((item) => item.family === options.family)
            : addresses;
          const selected = matching[0];
          if (!selected) {
            callback(new Error("No public address"), "", 4);
            return;
          }
          if (options.all) callback(null, matching);
          else callback(null, selected.address, selected.family);
        },
      },
    });
    try {
      const response = await safeFetch(url, {
        dispatcher,
        signal: timeout,
        redirect: "manual",
        headers: {
          "user-agent": "BELL-Web-Reader/0.1 (local personal study reader)",
          accept: "text/html,text/plain,text/markdown;q=0.9,application/xhtml+xml;q=0.9",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === 3) {
          throw new AppError(422, "重新導向次數過多，請改用最終文章網址。");
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
      if (!/text\/|application\/(xhtml\+xml|xml|json)/i.test(contentType)) {
        await response.body?.cancel();
        throw new AppError(422, "此網址不是可閱讀的文字網頁，請直接貼上內容。");
      }
      if (Number(response.headers.get("content-length") || 0) > MAX_BYTES) {
        await response.body?.cancel();
        throw new AppError(413, "網頁超過 1.5 MB 上限，請直接貼上想讀的段落。");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AppError(422, "無法讀取網頁內容。");
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          throw new AppError(413, "網頁超過 1.5 MB 上限，請直接貼上想讀的段落。");
        }
        chunks.push(value);
      }
      const html = Buffer.concat(chunks).toString("utf8");
      return { html, finalUrl: url, contentType };
    } finally {
      await dispatcher.close();
    }
  }
  throw new AppError(422, "無法讀取網頁。");
}

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_BLOCK_CHARS);
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

export function parsePastedContent(raw: string, explicitTitle?: string): ExtractedPage {
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
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```([a-z0-9_+-]*)\s*$/i.exec(line.trim());
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
    const heading = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3;
      const text = heading[2].trim();
      if (!inferredTitle && level === 1 && blocks.length === 0) {
        inferredTitle = text;
      } else {
        push({ kind: "heading", text, level });
      }
      i++;
      continue;
    }
    if (/^>\s*/.test(line.trim())) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s*/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s*/, ""));
        i++;
      }
      push({ kind: "quote", text: normalizeInline(quoteLines.join(" ")) });
      continue;
    }
    if (/^([-*+]|\d+\.)\s+/.test(line.trim())) {
      push({ kind: "list", text: normalizeInline(line.trim().replace(/^([-*+]|\d+\.)\s+/, "")) });
      i++;
      continue;
    }
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(```|#{1,3}\s+|>\s*|([-*+]|\d+\.)\s+)/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    push({ kind: "paragraph", text: normalizeInline(paraLines.join(" ")) });
  }

  if (!blocks.length) {
    blocks.push({ id: "b1", kind: "paragraph", text: cleaned.slice(0, MAX_BLOCK_CHARS) });
  }
  const title = (inferredTitle || blocks[0].text.slice(0, 42)).slice(0, 120);
  const firstProse = blocks.find((b) => b.kind !== "heading") ?? blocks[0];
  return {
    title,
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
