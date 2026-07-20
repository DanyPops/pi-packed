# pi-packed

Package service for the [Pi](https://github.com/earendil-works/pi) agent —
DNF-style package management that both **you** and the **agent** can use.

The agent gets native tools (`pkg_search`, `pkg_info`, `pkg_install`); you get
the `packed` CLI and an interactive `/packages` TUI. The extension is a thin,
Node-compatible client. Registry access, SQLite, and package execution remain
inside the supervised Bun daemon.

```text
┌─ Pi extension (Node-compatible) ──────────────┐
│ pkg_search · pkg_info · pkg_install · pkg_remove│
│ /packages · /packed permission settings         │
│ operation-aware approval · no Bun/SQLite access │
└──────────────────┬────────────────────────────┘
                   │ authenticated loopback HTTP
┌─ packed.service (Bun) ────────────────────────┐
│ typed package client API · watcher · mirror   │
│ npm registry · SQLite WAL · pi install/remove │
└───────────────────────────────────────────────┘
```

## Quickstart

```bash
bun test
packed service > ~/.config/systemd/user/packed.service
systemctl --user daemon-reload
systemctl --user enable --now packed.service

packed search lsp
packed install npm:pi-lsp
packed installed --json

# In Pi after installing the package:
/packages
```

Packages execute arbitrary code and mutate Pi settings/install roots. One daemon-owned operation policy classifies every public package operation. Install, update, remove, and security-setting changes require explicit approval by default (`mutationApproval: always`); search, info, installed, catalog, and update-status reads are bounded reads, while mirror refresh is classified maintenance. Open `/packed` to retain the recommended approval policy or deliberately choose the unsafe **Never require mutation approval** opt-out. `/packages` uses the same policy for updates and removals.

## CLI

| Command | What |
|---|---|
| `packed search <q> [--offline] [--limit N] [--json]` | Search npm or the local mirror, scoped to `keywords:pi-package` |
| `packed info <name> [--json]` | Show version, repository, Pi manifest, size, and license |
| `packed updates [--json]` | Show drift from the local mirror |
| `packed mirror [--json]` | Refresh the SQLite package index |
| `packed installed [--json]` | Read Pi's installed package declarations |
| `packed catalog [--json]` | Inspect the local package index |
| `packed install <source> [--approve] [--json]` | Authenticated daemon install for `npm:`, `git:`, or `https://` sources |
| `packed remove <name> [--approve] [--json]` | Authenticated daemon removal by bare npm name |
| `packed security [always\|never] [--approve] [--json]` | Read or set the package mutation approval policy |
| `packed serve` | Run the loopback daemon |
| `packed service` | Print the systemd user unit |
| `packed version` | Print the package/service version |

Guarded CLI mutations require `--approve` under the secure default. This is pi-packed mutation authorization, distinct from Pi's project-trust `--approve` semantics. Install/remove JSON results are stable objects:

```json
{"ok":true,"source":"npm:pi-lsp","output":"Installed npm:pi-lsp"}
```

Failures use exit code 1 and `{ "ok": false, ... , "error": "..." }` with
credential-safe diagnostics. Usage errors use exit code 2.

## Service API

Every route requires the bearer token stored in the private state directory.
The daemon listens on loopback only.

| Method | Route |
|---|---|
| `GET` | `/health` |
| `GET` | `/search?q=&limit=&offline=1` |
| `GET` | `/info?name=` |
| `GET` | `/installed` |
| `GET` | `/security` |
| `POST` | `/security` with `{ "mutationApproval": "always" | "never", "approved": true }` |
| `GET` | `/updates` |
| `GET` | `/catalog` |
| `POST` | `/install` with `{ "source": "...", "approved": true }` |
| `POST` | `/remove` with `{ "name": "...", "approved": true }` |

State defaults to `~/.cache/pi-packed/` and contains `token`, `port`,
`updates.json`, `security.json`, and `packed.db`. Relevant environment variables:

- `PI_PACKED_HOME`
- `PI_PACKED_PI_HOME`
- `PI_PACKED_WATCH_SECS`
- `PI_PACKED_CATALOG_SECS`
- `PI_PACKED_IDLE_SECS`
- `PI_PACKED_PI_BIN` / `PI_BIN`

## Architecture and safety

- **Daemon-owned SQLite:** extensions never open the mirror directly.
- **Runtime boundary:** extensions never call `Bun.spawn`; only the supervised
  Bun daemon owns the `ExecInstaller` adapter.
- **Authenticated typed client:** extension and mutation CLI paths call the same
  loopback API and reconnect after daemon restarts.
- **Ports and adapters:** registry and installer ports keep policy independent
  from npm, SQLite, subprocess, HTTP, and UI adapters.
- **Operation-aware authorization:** one policy matrix classifies reads, maintenance, code execution, settings mutation, and security mutation; guarded daemon routes reject missing approval with stable `approval_required` errors.
- **Allowlisted mutation input:** package sources and names reject shell
  metacharacters before reaching the installer.
- **Bounded requests:** daemon calls use timeouts and return structured errors
  without tokens or credentials.

## Development

```bash
bun test
bunx tsc --noEmit
```
