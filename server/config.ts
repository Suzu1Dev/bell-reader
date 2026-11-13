import { SUITE_APP_IDS, SUITE_LIMITS, type SuiteAppId, type SuiteLinks } from "../shared/suite.js";

export interface RuntimeConfig {
  host: string;
  port: number;
  dataDir: string;
  allowedOrigins: string[];
  suiteLinks: SuiteLinks;
  suiteFetch: Partial<Record<"explain" | "pr", string>>;
}

function loopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (bare === "::1" || bare === "localhost") return true;
  const parts = bare.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function loopbackIpLiteral(hostname: string): boolean {
  return hostname !== "localhost" && loopbackHostname(hostname);
}

function tailnetOf(hostname: string): string | undefined {
  const labels = hostname.toLowerCase().split(".");
  return labels.length >= 4 && labels.at(-1) === "net" && labels.at(-2) === "ts" ? labels.slice(-3).join(".") : undefined;
}

function exactOrigin(value: string, variable: string): URL {
  if (!/^https?:\/\/[^/?#\\\s@*]+$/i.test(value) || value.endsWith(":")) {
    throw new Error(`${variable} 格式錯誤：必須是不含路徑、查詢或萬用字元的完整 origin。`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} 格式錯誤：無法解析網址。`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port === "0") {
    throw new Error(`${variable} 格式錯誤：不得含帳密、路徑、查詢參數或 port 0。`);
  }
  return url;
}

export function parseAllowedOrigins(raw: string | undefined, variable = "BELL_READER_ALLOWED_ORIGINS"): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  return text.split(",").map((entry) => {
    const url = exactOrigin(entry.trim(), variable);
    if (!loopbackHostname(url.hostname) && url.protocol !== "https:") {
      throw new Error(`${variable} 格式錯誤：非本機來源必須使用 https。`);
    }
    return url.origin;
  });
}

export function parseSuiteLinks(
  raw: string | undefined,
  ownOrigins: string[],
  variable = "BELL_READER_SUITE_LINKS",
): SuiteLinks {
  const text = (raw ?? "").trim();
  if (!text) return {};
  const parts = text.split(",").map((part) => part.trim());
  if (parts.length > SUITE_LIMITS.links) {
    throw new Error(`${variable} 最多支援 ${SUITE_LIMITS.links} 個產品連結。`);
  }
  const ownTailnets = new Set(
    ownOrigins
      .map((origin) => {
        try {
          return tailnetOf(new URL(origin).hostname);
        } catch {
          return undefined;
        }
      })
      .filter((item): item is string => Boolean(item)),
  );
  const seen = new Set<string>();
  const links: SuiteLinks = {};
  for (const part of parts) {
    const match = /^([a-z]+)=(.+)$/.exec(part);
    if (!match) throw new Error(`${variable} 格式錯誤：每項須為 appId=origin。`);
    const [, appId, value] = match;
    if (seen.has(appId)) throw new Error(`${variable} 重複設定了 ${appId}。`);
    seen.add(appId);
    if (!SUITE_APP_IDS.includes(appId as SuiteAppId) || appId === "reader") {
      throw new Error(`${variable} 不支援或指向自身：${appId}。`);
    }
    const url = exactOrigin(value, `${variable}.${appId}`);
    if (!loopbackHostname(url.hostname)) {
      if (url.protocol !== "https:") throw new Error(`${variable}.${appId} 非本機來源必須使用 https。`);
      const tailnet = tailnetOf(url.hostname);
      if (!tailnet || !ownTailnets.has(tailnet)) {
        throw new Error(`${variable}.${appId} 僅允許與本服務相同的 Tailscale tailnet。`);
      }
    }
    links[appId as SuiteAppId] = url.origin;
  }
  return links;
}

export function parseSuiteFetch(
  raw: string | undefined,
  variable = "BELL_READER_SUITE_FETCH",
): Partial<Record<"explain" | "pr", string>> {
  const text = (raw ?? "").trim();
  if (!text) return {};
  const parts = text.split(",").map((part) => part.trim());
  const seen = new Set<string>();
  const targets: Partial<Record<"explain" | "pr", string>> = {};
  for (const part of parts) {
    const match = /^([a-z]+)=(.+)$/.exec(part);
    if (!match) throw new Error(`${variable} 格式錯誤：每項須為 appId=origin。`);
    const [, appId, value] = match;
    if (seen.has(appId)) throw new Error(`${variable} 重複設定了 ${appId}。`);
    seen.add(appId);
    if (appId !== "explain" && appId !== "pr") {
      throw new Error(`${variable} 只支援讀取 explain 或 pr。`);
    }
    const url = exactOrigin(value, `${variable}.${appId}`);
    if (url.protocol !== "http:" || !loopbackIpLiteral(url.hostname)) {
      throw new Error(`${variable}.${appId} 伺服器讀取只允許 http://127.x.x.x:port 或 http://[::1]:port。`);
    }
    targets[appId] = url.origin;
  }
  return targets;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const port = Number(env.BELL_READER_PORT || env.PORT || 4630);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT 必須是 1–65535 的整數。");
  }
  const host = (env.BELL_READER_HOST || env.HOST || "127.0.0.1").trim();
  const dataDir = (env.BELL_READER_DATA_DIR || "./data").trim();
  const allowedOrigins = parseAllowedOrigins(env.BELL_READER_ALLOWED_ORIGINS);
  const suiteLinks = parseSuiteLinks(env.BELL_READER_SUITE_LINKS, allowedOrigins);
  const suiteFetch = parseSuiteFetch(env.BELL_READER_SUITE_FETCH);
  return { host, port, dataDir, allowedOrigins, suiteLinks, suiteFetch };
}
