import type { NextFunction, Request, Response } from "express";

function localHostsForPort(port: number | undefined): Set<string> {
  const hosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (port) {
    hosts.add(`127.0.0.1:${port}`);
    hosts.add(`localhost:${port}`);
    hosts.add(`[::1]:${port}`);
  }
  return hosts;
}

export function securityMiddleware(allowedOrigins: readonly string[]) {
  const allowedOriginSet = new Set(allowedOrigins);
  const allowedHostSet = new Set(
    allowedOrigins.map((origin) => new URL(origin).host.toLowerCase()),
  );

  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
    );
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");

    const localPort = req.socket.localPort;
    const localHosts = localHostsForPort(localPort);
    const hostHeader = (req.headers.host ?? "").toLowerCase();
    if (!hostHeader || (!localHosts.has(hostHeader) && !allowedHostSet.has(hostHeader))) {
      res.status(403).json({ error: "不允許的 Host 來源。" });
      return;
    }

    const isApi = req.path === "/api" || req.path.startsWith("/api/");
    const secFetchSite = req.headers["sec-fetch-site"];
    const isTopDocNav =
      !isApi &&
      (req.method === "GET" || req.method === "HEAD") &&
      req.headers["sec-fetch-mode"] === "navigate" &&
      req.headers["sec-fetch-dest"] === "document";

    if (secFetchSite === "cross-site" && !isTopDocNav) {
      res.status(403).json({ error: "拒絕跨站請求。" });
      return;
    }

    const origin = req.headers.origin;
    if (origin) {
      let validOrigin = allowedOriginSet.has(origin);
      if (!validOrigin) {
        try {
          const parsed = new URL(origin);
          validOrigin =
            (parsed.protocol === "http:" || parsed.protocol === "https:") &&
            localHosts.has(parsed.host.toLowerCase());
        } catch {
          validOrigin = false;
        }
      }
      if (!validOrigin) {
        res.status(403).json({ error: "不允許的 Origin 來源。" });
        return;
      }
    }

    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      const contentType = req.headers["content-type"] ?? "";
      if (!/^application\/json\b/i.test(contentType)) {
        res.status(415).json({ error: "寫入請求必須使用 application/json。" });
        return;
      }
    }

    next();
  };
}
