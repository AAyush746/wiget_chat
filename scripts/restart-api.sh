#!/usr/bin/env bash
# Restart the built API and wait until it actually answers health checks.
# Used during development because the API is run from dist/ and must be
# restarted explicitly after each rebuild.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${1:-/tmp/opencode/api.log}"

pkill -9 -f "dist/main" >/dev/null 2>&1 || true
for _ in $(seq 1 20); do
  pgrep -f "dist/main" >/dev/null 2>&1 || break
  sleep 0.5
done

cd "$ROOT/apps/api" || exit 1
setsid node dist/main > "$LOG" 2>&1 < /dev/null &
disown

for _ in $(seq 1 40); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:4000/api/health || true)"
  if [ "$code" = "200" ]; then
    echo "api healthy (pid $(pgrep -f 'dist/main' | head -1))"
    exit 0
  fi
  sleep 1
done

echo "api failed to become healthy; last log lines:" >&2
grep -vE 'Mapped|RouterExplorer|\[Nest\].*LOG' "$LOG" | tail -20 >&2
exit 1
