#!/usr/bin/env bash
# Reports which Yarvis setup steps are already done, one line per check.
# Read-only: it installs, starts and changes nothing.
# Usage: check.sh [database-name]   (default: yarvis)

# No -e: a failed check is reported, not fatal.
set -u

DB="${1:-yarvis}"
# A bare name only: psql -d also accepts a connection string, which could point
# the checks at another host.
[[ "$DB" =~ ^[A-Za-z0-9_]+$ ]] || { echo "invalid database name: $DB" >&2; exit 2; }

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"

ok()      { printf 'OK      %-22s %s\n' "$1" "$2"; }
missing() { printf 'MISSING %-22s %s\n' "$1" "$2"; }
warn()    { printf 'WARN    %-22s %s\n' "$1" "$2"; }

have() { command -v "$1" >/dev/null 2>&1; }

# -X skips ~/.psqlrc, which can run arbitrary commands.
q() { psql -X -At "$@" 2>/dev/null; }

echo "repo: $REPO"
echo "arch: $(uname -m)  macOS $(sw_vers -productVersion 2>/dev/null || echo '?')"

# Homebrew's postgresql@17 is keg-only, so its tools may be installed but not on PATH.
for dir in /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin; do
  if ! have psql && [ -x "$dir/psql" ]; then
    warn "postgres-path" "psql found in $dir but not on PATH"
    PATH="$dir:$PATH"
  fi
done

if xcode-select -p >/dev/null 2>&1; then ok "xcode-clt" "$(xcode-select -p)"; else missing "xcode-clt" "run: xcode-select --install"; fi
if have brew; then ok "homebrew" "$(brew --version 2>/dev/null | head -1)"; else missing "homebrew" "see https://brew.sh"; fi
if have mise; then ok "mise" "$(mise --version 2>/dev/null)"; else warn "mise" "not installed (optional; the repo lists bun and rust in mise.toml)"; fi
if have bun; then ok "bun" "$(bun --version)"; else missing "bun" "install with mise, or https://bun.com"; fi
if have cargo; then ok "rust" "$(cargo --version)"; else missing "rust" "install with mise, or https://rustup.rs"; fi

if have psql; then
  ok "psql" "$(psql --version)"
  if pg_isready -q 2>/dev/null; then
    ok "postgres-server" "accepting connections"
    if [ "$(q -d postgres -c "select count(*) from pg_available_extensions where name = 'vector'")" = "1" ]; then
      ok "pgvector" "available to this server"
    else
      missing "pgvector" "run: brew install pgvector (built for Homebrew's postgresql@17)"
    fi
    if q -d "$DB" -c 'select 1' >/dev/null; then
      ok "database" "$DB exists"
      if [ "$(q -d "$DB" -c "select count(*) from pg_extension where extname = 'vector'")" = "1" ]; then
        ok "vector-extension" "enabled in $DB"
      else
        missing "vector-extension" "run: psql -d '$DB' -c 'CREATE EXTENSION IF NOT EXISTS vector;'"
      fi
      tables="$(q -d "$DB" -c "select count(*) from information_schema.tables where table_schema = 'public'")"
      if [ "${tables:-0}" -gt 0 ]; then
        ok "migrations" "$tables tables in $DB (the app has connected)"
      else
        warn "migrations" "no tables yet; they appear once the app connects"
      fi
    else
      missing "database" "run: createdb '$DB'"
    fi
  else
    missing "postgres-server" "not reachable; run: brew services start postgresql@17"
  fi
else
  missing "psql" "run: brew install postgresql@17 pgvector"
fi

if [ -d "$REPO/node_modules" ]; then ok "bun-install" "node_modules present"; else missing "bun-install" "run: bun install (in $REPO)"; fi

if have claude; then ok "claude-code" "$(claude --version 2>/dev/null | head -1)"; else warn "claude-code" "not on PATH (needed for workspaces)"; fi
if have gh && gh extension list 2>/dev/null | grep -q "gh-stack"; then
  ok "gh-stack" "gh and gh-stack installed"
else
  warn "gh-stack" "optional: brew install gh && gh extension install github/gh-stack (for the Stack tab)"
fi
if have uv; then ok "uv" "$(uv --version)"; else warn "uv" "optional: brew install uv (for local voice)"; fi
if [ -d "$REPO/.venv" ]; then ok "speech-venv" ".venv present"; else warn "speech-venv" "optional: uv sync (for local voice)"; fi
if have op; then ok "1password-cli" "$(op --version)"; else warn "1password-cli" "optional (only to keep secrets in 1Password)"; fi

if [ -f "$HOME/.yarvis/settings.json" ]; then ok "settings-file" "~/.yarvis/settings.json exists"; else warn "settings-file" "none yet (fine: defaults apply)"; fi
