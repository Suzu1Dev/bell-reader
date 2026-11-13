# BELL Web Reader

**English** · [繁體中文](./README.zh-TW.md)

Local-first web article snapshot and organic ink annotation reader. Capture public HTTPS articles (with DNS-pinned SSRF protection) or paste Markdown/prose into a clean offline SQLite library, then annotate directly on the page with hand-drawn SVG highlights, underlines, boxes, brackets, margin notes, and sketches.

Runs out-of-the-box as an **independent Standalone App** (zero environment variables required) or as part of **[BELL Suite](https://github.com/Suzu1Dev/bell-suite)** alongside Personal, Explain, BELL PR, and Campaign.

## Quick Start

### Install in One Line (macOS / Linux / WSL)

```bash
curl -fsSL https://raw.githubusercontent.com/Suzu1Dev/bell-reader/main/install.sh | sh
bell-reader
```

The installer checks npm first and automatically falls back to cloning from GitHub (`~/.local/share/bell-reader/app`) and symlinking `~/.local/bin/bell-reader`, bootstrapping Node.js 24 if needed.

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/Suzu1Dev/bell-reader/main/install.ps1 | iex
bell-reader
```

### Run via `npx` or From Source

```bash
# Run directly with npx
npx bell-reader

# Or clone and run from source
git clone https://github.com/Suzu1Dev/bell-reader.git
cd bell-reader
npm install && npm run build
./bin/bell-reader.mjs start
```

## CLI Usage

```text
bell-reader [start] [--port <n>] [--host <h>] [--no-open] [--suite]
bell-reader doctor [--json]
bell-reader --version | --help
```

- **Standalone Edition (default)**: listens on `http://127.0.0.1:4630` with local SQLite storage in `./data/` (checkout) or `~/.bell-reader/data/` (global install).
- **BELL Suite Edition (`--suite` or `bell-suite start`)**: listens on `http://127.0.0.1:4604`, matches reading topics against local BELL Explain notes, accepts `#/read?text=...` handoffs, and sends pages/annotations to BELL Explain (`#/explain`), BELL Personal (`#/tasks`), or BELL PR (`#/discover`).

## Architecture Overview

```text
bin/bell-reader.mjs    Standalone & Suite CLI (start, doctor, --version, --help)
src/                   React 19 editorial reader, Range-anchored RoughJS/freehand ink stage,
                       margin cards, bilingual translation view, and Suite switcher
shared/                TypeScript page/annotation schemas and Suite Contract v1 routes
server/                Express 5 API, SSRF-hardened HTML extractor, SQLite store (node:sqlite),
                       optional AI doodle/selection/translation runners, Explain topic bridge
Formula/               Homebrew formula template
```

## Development & Verification

Requires **Node.js 22.13+** (Node.js 24 LTS recommended) for built-in `node:sqlite`.

```bash
npm install
npm run dev        # Vite frontend + API watch
npm test           # Unit & integration test suite
npm run build      # TypeScript check + production Vite bundle
```

## License

[Apache-2.0](./LICENSE) · [Trademarks](./TRADEMARKS.md)
