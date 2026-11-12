import http from "node:http";
import {
  SUITE_LIMITS,
  SUITE_OBJECT_ID,
  SUITE_UNSAFE_TEXT,
  allowedSuiteRoute,
} from "../shared/suite.js";
import type { ExplainBridgeStatus, ExplainTopicMatch, SavedPage } from "../shared/types.js";

// Dedicated agent so host proxy vars (NODE_USE_ENV_PROXY / http_proxy) never intercept loopback sibling reads.
const loopbackAgent = new http.Agent({ keepAlive: false });

interface ExplainEntry {
  id: string;
  title: string;
  category?: string;
  tags: string[];
  url?: string;
  href: string;
}

interface CacheState {
  entries: ExplainEntry[];
  lastAttemptAt: number;
  lastSuccessAt?: number;
  lastFailed: boolean;
  inflight?: Promise<void>;
}

function fetchJsonBounded(url: string): Promise<unknown> {
  // shortcut: 256 KB cap when reading /api/lessons fallback, tighten once /api/suite/topics is deployed everywhere
  const maxBytes = url.endsWith("/api/lessons") ? 256 * 1024 : SUITE_LIMITS.fetchMaxBytes;
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: http.ClientRequest | undefined;
    const finish = (err: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        request?.destroy();
        reject(err);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(new Error("Timeout")), SUITE_LIMITS.fetchTimeoutMs);
    request = http.request(
      {
        agent: loopbackAgent,
        protocol: "http:",
        hostname: target.hostname.replace(/^\[(.*)\]$/, "$1"),
        port: Number(target.port || 80),
        method: "GET",
        path: `${target.pathname}${target.search}`,
        headers: { Accept: "application/json" },
      },
      (res) => {
        if (res.statusCode !== 200) return finish(new Error(`HTTP ${res.statusCode}`));
        const ct = String(res.headers["content-type"] ?? "");
        if (!/^application\/json\b/i.test(ct)) return finish(new Error("Non-JSON response"));
        if (Number(res.headers["content-length"]) > maxBytes) return finish(new Error("Response too large"));
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) finish(new Error("Response too large"));
          else chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            finish(null, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
          } catch {
            finish(new Error("Invalid JSON"));
          }
        });
        res.on("error", () => finish(new Error("Read failed")));
        res.on("close", () => {
          if (!res.complete) finish(new Error("Closed prematurely"));
        });
      },
    );
    request.on("error", () => finish(new Error("Connect failed")));
    request.end();
  });
}

function sanitizeEntry(raw: Record<string, unknown>): ExplainEntry | undefined {
  const id = typeof raw.id === "string" ? raw.id : "";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!SUITE_OBJECT_ID.test(id) || id === "." || id === "..") return undefined;
  if (!title || title.length > SUITE_LIMITS.title || SUITE_UNSAFE_TEXT.test(title)) return undefined;
  const href = typeof raw.href === "string" && allowedSuiteRoute("explain", raw.href)
    ? raw.href
    : `#/note/${id}`;
  if (!allowedSuiteRoute("explain", href)) return undefined;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === "string" && t.length <= 40 && !SUITE_UNSAFE_TEXT.test(t)).slice(0, 8)
    : [];
  const category =
    typeof raw.category === "string" && raw.category.length <= 40 && !SUITE_UNSAFE_TEXT.test(raw.category)
      ? raw.category
      : undefined;
  const sourceObj = raw.source && typeof raw.source === "object" ? (raw.source as Record<string, unknown>) : undefined;
  const url =
    typeof raw.url === "string"
      ? raw.url
      : typeof sourceObj?.url === "string"
        ? sourceObj.url
        : undefined;
  return { id, title, ...(category ? { category } : {}), tags, ...(url ? { url } : {}), href };
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[\s\-_·.,:;!?()[\]{}"'「」『』《》]/g, "");
}

export class ExplainBridge {
  private readonly cache: CacheState = {
    entries: [],
    lastAttemptAt: 0,
    lastFailed: false,
  };

  constructor(
    private readonly fetchOrigin?: string,
    private readonly browserOrigin?: string,
  ) {}

  private async refresh(force = false): Promise<void> {
    if (!this.fetchOrigin) return;
    const now = Date.now();
    if (!force && this.cache.lastAttemptAt && now - this.cache.lastAttemptAt < SUITE_LIMITS.cacheFreshMs) {
      return;
    }
    if (this.cache.inflight) {
      await this.cache.inflight;
      return;
    }
    this.cache.inflight = (async () => {
      this.cache.lastAttemptAt = Date.now();
      try {
        let parsedEntries: ExplainEntry[] | undefined;
        // 1. Try minimized /api/suite/topics first
        try {
          const data = (await fetchJsonBounded(`${this.fetchOrigin}/api/suite/topics`)) as {
            topics?: unknown[];
          };
          if (Array.isArray(data?.topics)) {
            parsedEntries = data.topics
              .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
              .flatMap((item) => sanitizeEntry(item) ?? []);
          }
        } catch {
          // Fallback to /api/lessons or /api/suite/today on v1 Explain instances
        }

        if (!parsedEntries) {
          try {
            const lessons = await fetchJsonBounded(`${this.fetchOrigin}/api/lessons`);
            if (Array.isArray(lessons)) {
              parsedEntries = lessons
                .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
                .flatMap((item) => sanitizeEntry(item) ?? []);
            }
          } catch {
            const today = (await fetchJsonBounded(`${this.fetchOrigin}/api/suite/today`)) as {
              items?: unknown[];
            };
            if (Array.isArray(today?.items)) {
              parsedEntries = today.items
                .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
                .flatMap((item) => sanitizeEntry(item) ?? []);
            }
          }
        }

        if (!parsedEntries) throw new Error("No valid Explain endpoint");
        this.cache.entries = parsedEntries;
        this.cache.lastSuccessAt = Date.now();
        this.cache.lastFailed = false;
      } catch {
        this.cache.lastFailed = true;
        if (
          this.cache.lastSuccessAt &&
          Date.now() - this.cache.lastSuccessAt > SUITE_LIMITS.staleDropMs
        ) {
          this.cache.entries = [];
        }
      } finally {
        this.cache.inflight = undefined;
      }
    })();
    await this.cache.inflight;
  }

  async matchForPage(page: SavedPage, forceRefresh = false): Promise<ExplainBridgeStatus> {
    if (!this.fetchOrigin) {
      return {
        status: "unconfigured",
        ...(this.browserOrigin ? { browserOrigin: this.browserOrigin } : {}),
        matches: [],
      };
    }
    await this.refresh(forceRefresh);

    const hasRecentSuccess =
      this.cache.lastSuccessAt !== undefined &&
      Date.now() - this.cache.lastSuccessAt <= SUITE_LIMITS.staleDropMs;

    if (this.cache.lastFailed && !hasRecentSuccess) {
      return {
        status: "unavailable",
        ...(this.browserOrigin ? { browserOrigin: this.browserOrigin } : {}),
        matches: [],
      };
    }

    const status = this.cache.lastFailed ? "stale" : "ready";
    const terms = new Map<string, string>();
    const addTerm = (raw: string | undefined) => {
      if (!raw || raw === "未分類") return;
      const norm = normalizeToken(raw);
      if (norm.length >= 2 && !terms.has(norm)) terms.set(norm, raw.trim());
    };

    addTerm(page.topic);
    for (const tag of page.tags) addTerm(tag);
    for (const ann of page.annotations) {
      addTerm(ann.topic);
      if (ann.quote.length <= 24) addTerm(ann.quote);
    }
    for (const part of page.title.split(/[\s·—\-:|/、，]+/)) {
      if (part.trim().length >= 2 && part.trim().length <= 24) addTerm(part);
    }

    const scored: Array<{ entry: ExplainEntry; score: number; reason: string }> = [];
    for (const entry of this.cache.entries) {
      if (page.url && entry.url && page.url === entry.url) {
        scored.push({ entry, score: 100, reason: "同一來源網址" });
        continue;
      }
      const entryTitleNorm = normalizeToken(entry.title);
      const entryCategoryNorm = entry.category ? normalizeToken(entry.category) : "";
      const entryTagsNorm = entry.tags.map((t) => ({ raw: t, norm: normalizeToken(t) }));

      let bestScore = 0;
      let bestReason = "";
      for (const [norm, display] of terms) {
        if (!norm) continue;
        if (entryTagsNorm.some((t) => t.norm === norm || (t.norm.length >= 2 && (t.norm.includes(norm) || norm.includes(t.norm))))) {
          if (bestScore < 30) {
            bestScore = 30;
            bestReason = `相同主題：${display}`;
          }
        } else if (entryTitleNorm.includes(norm) || (entryTitleNorm.length >= 2 && norm.includes(entryTitleNorm))) {
          if (bestScore < 25) {
            bestScore = 25;
            bestReason = `相關筆記：${display}`;
          }
        } else if (entryCategoryNorm && (entryCategoryNorm === norm || entryCategoryNorm.includes(norm))) {
          if (bestScore < 15) {
            bestScore = 15;
            bestReason = `同分類：${entry.category}`;
          }
        }
      }
      if (bestScore > 0) {
        scored.push({ entry, score: bestScore, reason: bestReason });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const matches: ExplainTopicMatch[] = scored.slice(0, 5).map(({ entry, reason }) => ({
      id: entry.id,
      title: entry.title,
      ...(entry.category ? { category: entry.category } : {}),
      tags: entry.tags,
      href: entry.href,
      reason,
    }));

    return {
      status,
      ...(this.browserOrigin ? { browserOrigin: this.browserOrigin } : {}),
      matches,
    };
  }

  async listAllTopics(forceRefresh = false): Promise<{
    status: ExplainBridgeStatus["status"];
    browserOrigin?: string;
    entries: ExplainEntry[];
  }> {
    if (!this.fetchOrigin) {
      return {
        status: "unconfigured",
        ...(this.browserOrigin ? { browserOrigin: this.browserOrigin } : {}),
        entries: [],
      };
    }
    await this.refresh(forceRefresh);
    const hasRecentSuccess =
      this.cache.lastSuccessAt !== undefined &&
      Date.now() - this.cache.lastSuccessAt <= SUITE_LIMITS.staleDropMs;
    if (this.cache.lastFailed && !hasRecentSuccess) {
      return {
        status: "unavailable",
        ...(this.browserOrigin ? { browserOrigin: this.browserOrigin } : {}),
        entries: [],
      };
    }
    return {
      status: this.cache.lastFailed ? "stale" : "ready",
      ...(this.browserOrigin ? { browserOrigin: this.browserOrigin } : {}),
      entries: this.cache.entries,
    };
  }
}
