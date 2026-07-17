# pi-packed

Package service for the [Pi](https://github.com/earendil-works/pi-coding-agent) agent —
DNF-style package management that both **you** and the **agent** can use.

The agent gets tools (`pkg_search`, `pkg_info`, `pkg_install`); you get a CLI
(`packed`) and an interactive TUI (`/packages`). All logic lives in a
long-running Bun service — the extension is a thin seam.

```
┌─ Pi extension seam (extension/src) ───────────┐
│ pkg_search/pkg_info/pkg_install tools         │
│ /packages TUI · session_start notify          │
│ thin: exec `bun src/cli.ts …`, confirm gates  │
└───────────────┬───────────────────────────────┘
                │ CLI (same hexagon ports)
┌─ Bun service (src/) ──────────────────────────┼──────────┐
│ cli.ts (command table) · service.ts (fetch)   │          │
│ daemon: watcher (update drift) + catalogSync  │          │
│ npm registry adapter · pi install exec adapter│          │
└───────────────────────────────────────────────┴──────────┘
```

## Quickstart

```bash
bun test                          # 52 tests
bun src/cli.ts search lsp         # one-shot, direct to npm
bun src/cli.ts serve &            # long-running service (warm cache + watcher)
bun src/cli.ts updates            # diff installed vs latest

# In Pi:
pi -e /path/to/pi-packed/extension/src/index.ts   # ephemeral
# or: pi install git:github.com/dpopsuev/pi-packed
/packages                                              # interactive panel
```

## CLI

| Command | What |
|---|---|
| `packed search <q> [--limit N] [--json]` | npm search scoped to `keywords:pi-package` |
| `packed info <name> [--json]` | version, repo, pi manifest, size |
| `packed updates [--cached]` | drift vs dist-tags.latest (`--cached` = watcher snapshot) |
| `packed installed` | parse `~/.pi/agent/settings.json` (+ node_modules versions) |
| `packed catalog` | full pi-package snapshot (hot browse) |
| `packed install <source>` | allowlisted: `npm:` / `git:` / `https://` |
| `packed remove <name>` | bare npm name |
| `packed serve` | daemon: HTTP API + watcher + catalog sync + idle self-exit |

## Service API (loopback + bearer token)

`GET /health` · `GET /search?q=&limit=` · `GET /info?name=` · `POST /install`
· `GET /updates` · `GET /catalog`

State in `~/.cache/pi-packed/` (`PI_PACKED_HOME`): `token`, `port`,
`updates.json`, `catalog.json`. Env knobs: `PI_PACKED_WATCH_SECS` (default
30min), `PI_PACKED_CATALOG_SECS` (6h), `PI_PACKED_IDLE_SECS` (10min),
`PI_PACKED_PI_HOME`, `PACKED_CLI` / `PACKED_BIN` (seam overrides).

## Architecture (patterns)

| Pattern | Where |
|---|---|
| Ports & Adapters | `ports.ts` interfaces; drivers: HTTP, CLI, watcher, tests; driven: npm, pi exec |
| Proxy | daemon = caching/protection proxy of npm; `DaemonRegistry` = remote proxy |
| Facade | lean JSON over npm's verbose documents |
| Event-driven | watcher + catalogSync produce snapshots; seam consumes on `session_start` → `ctx.ui.notify` (event-carried state, no callbacks) |
| Command | `cli.ts` command table (go-tool/Cobra convention, zero deps) |
| Deep module | tiny API surface, rich internals — one package, no sprawl |

## Decisions

- **Bun/TS over Go/Rust**: one language end-to-end, no build step (Bun runs
  TS directly), `pi install git:…` works without binaries. Service is
  IO-bound; runtime perf is irrelevant.
- **No Cobra/urfave**: agent-first CLI; stdlib-style flag parsing with
  flags-anywhere support (LLMs emit flags in random positions).
- **npm registry is the source of truth** (5,500+ pkgs): pi.dev has no API
  (`/api/*` → "reserved for future features"), its gallery is curated HTML
  (~50/page, server-side `?name=` filter). Catalog sync paginates
  `keywords:pi-package` (250/page) into `catalog.json`, TTL 6h — npm's
  search API has no ETag, so conditional revalidation is impossible.
- **Install validation** is an allowlist regex (defense-in-depth on top of
  the bearer token): no shell metacharacters, ever.

## Roadmap

- `pi.dev` JSON API when it ships (currently 501 reserved)
- `replicate.npmjs.com` changes feed for near-real-time catalog
- Unix socket transport; `bun build --compile` single-binary distribution
- `/packages` remote-browse view fed by `catalog.json`
