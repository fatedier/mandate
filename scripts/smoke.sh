#!/usr/bin/env bash
set -euo pipefail

# Pick a random unused TCP port. Asks the OS for an ephemeral one and immediately
# releases it; the tiny race window before our server binds is acceptable for smoke.
SMOKE_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()")
API="http://127.0.0.1:${SMOKE_PORT}"

# Isolate everything: a unique data dir holds both mandate.db and ~/.mandate/worktrees,
# so smoke leaves zero residue and never collides with a developer's dev server.
SMOKE_DATA=$(mktemp -d -t mandate-smoke-XXXXXX)
SERVER_LOG=$(mktemp -t mandate-smoke-log-XXXXXX)
PROJECT_NAME="smoke_$(date +%s)_$$"
# The project's tmux session, as the server names it (md-<name>-<hash>).
SESSION_NAME=""
WD=$(mktemp -d)
GIT_REPO=""
GIT_SESSION_NAME=""

cleanup() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    echo "==> FAIL — last 50 lines of server log:" >&2
    tail -50 "$SERVER_LOG" >&2 || true
  fi
  kill "${SERVER_PID:-}" 2>/dev/null || true
  # tmux sessions: kill any we may have created (silent on missing).
  [ -n "${SESSION_NAME:-}" ] && tmux kill-session -t "${SESSION_NAME}" 2>/dev/null || true
  [ -n "${GIT_SESSION_NAME:-}" ] && tmux kill-session -t "${GIT_SESSION_NAME}" 2>/dev/null || true
  # Filesystem cleanup. SMOKE_DATA holds the isolated DB + worktrees tree.
  rm -rf "${WD:-}" "${GIT_REPO:-}" "${SMOKE_DATA:-}" "${SERVER_LOG:-}" 2>/dev/null || true
  exit "$exit_code"
}
trap cleanup EXIT

echo "==> starting server on port ${SMOKE_PORT} (data=${SMOKE_DATA})"
MANDATE_DATA_DIR="$SMOKE_DATA" \
  env PATH="$PATH" bun src/server/server.ts serve --port "$SMOKE_PORT" > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# Wait for readiness instead of fixed sleep — fail fast if server crashed.
for i in {1..30}; do
  if curl -fsS "${API}/api/info" > /dev/null 2>&1; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "FAIL: server died before becoming ready" >&2
    exit 1
  fi
  sleep 0.2
done
curl -fsS "${API}/api/info" > /dev/null || { echo "FAIL: server never reached /api/info"; exit 1; }

echo "==> creating project"
PROJECT=$(curl -fsS -X POST "${API}/api/projects" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"${PROJECT_NAME}\",\"workingDir\":\"${WD}\"}")
PROJECT_ID=$(echo "$PROJECT" | jq -r '.id')
SESSION_NAME=$(echo "$PROJECT" | jq -r '.tmuxSessionName')
echo "    id=$PROJECT_ID session=$SESSION_NAME"

echo "==> checking tmux session exists"
tmux has-session -t "$SESSION_NAME" || { echo "FAIL: tmux session missing"; exit 1; }

echo "==> creating worker"
WORKER=$(curl -fsS -X POST "${API}/api/projects/${PROJECT_ID}/workers" \
  -H 'content-type: application/json' \
  -d '{"name":"smoke-worker","mode":"shared-cwd"}')
WORKER_ID=$(echo "$WORKER" | jq -r '.id')
echo "    id=$WORKER_ID"

echo "==> checking tmux window exists"
tmux list-windows -t "$SESSION_NAME" -F '#{window_name}' | grep -q '^smoke_worker$' \
  || { echo "FAIL: tmux window missing"; exit 1; }

echo "==> creating git project for worktree smoke"
GIT_REPO=$(mktemp -d)
git -C "$GIT_REPO" init -b main >/dev/null
git -C "$GIT_REPO" config user.email "smoke@smoke" >/dev/null
git -C "$GIT_REPO" config user.name "smoke" >/dev/null
echo x > "$GIT_REPO/README"
git -C "$GIT_REPO" add . >/dev/null
git -C "$GIT_REPO" commit -m init >/dev/null

GIT_PROJECT=$(curl -fsS -X POST "${API}/api/projects" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"${PROJECT_NAME}_git\",\"workingDir\":\"${GIT_REPO}\"}")
GIT_PROJECT_ID=$(echo "$GIT_PROJECT" | jq -r '.id')
GIT_SESSION_NAME=$(echo "$GIT_PROJECT" | jq -r '.tmuxSessionName')

echo "==> creating worktree worker"
WT_WORKER=$(curl -fsS -X POST "${API}/api/projects/${GIT_PROJECT_ID}/workers" \
  -H 'content-type: application/json' \
  -d '{"name":"smoke-wt","mode":"new-branch-new-worktree","branch":"smoke-branch"}')
WT_PATH=$(echo "$WT_WORKER" | jq -r '.worktreePath')

echo "==> checking worktree dir exists"
[ -f "$WT_PATH/README" ] || { echo "FAIL: worktree README missing at $WT_PATH"; exit 1; }

echo "==> archiving worktree worker, removing its worktree"
WT_WORKER_ID=$(echo "$WT_WORKER" | jq -r '.id')
curl -fsS -X DELETE "${API}/api/workers/${WT_WORKER_ID}?removeWorktree=true" > /dev/null

echo "==> checking worktree gone"
[ -e "$WT_PATH" ] && { echo "FAIL: worktree path still exists"; exit 1; } || true

echo "==> reconcile rebuilds an app-owned project after external kill"
tmux kill-session -t "$GIT_SESSION_NAME" 2>/dev/null || true
RECONCILE_REBUILT=$(curl -fsS -X POST "${API}/api/projects/${GIT_PROJECT_ID}/reconcile" \
  -H 'content-type: application/json' -d '{}')
[ "$(echo "$RECONCILE_REBUILT" | jq -r '.rebuilt')" = "true" ] \
  || { echo "FAIL: app-owned reconcile did not rebuild ($RECONCILE_REBUILT)"; exit 1; }
tmux has-session -t "$GIT_SESSION_NAME" 2>/dev/null \
  || { echo "FAIL: tmux session not present after reconcile"; exit 1; }

echo "==> archiving git project"
curl -fsS -X DELETE "${API}/api/projects/${GIT_PROJECT_ID}?killTmux=true" > /dev/null

echo "==> archiving worker"
curl -fsS -X DELETE "${API}/api/workers/${WORKER_ID}" > /dev/null

echo "==> archiving project"
curl -fsS -X DELETE "${API}/api/projects/${PROJECT_ID}?killTmux=true" > /dev/null

echo "==> checking tmux session is gone"
tmux has-session -t "$SESSION_NAME" 2>/dev/null && { echo "FAIL: session still alive"; exit 1; } || true

echo "==> smoke OK"
