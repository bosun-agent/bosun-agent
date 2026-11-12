#!/usr/bin/env bash
# BOSUN 실행 스크립트 — Portainer → WEB 백엔드(+Agent) → 화면을 한 번에 띄운다.
#
#   ./scripts/up.sh              준비된 설정으로 실행 (Ctrl+C로 전부 종료)
#   ./scripts/up.sh --check      띄우지 않고 준비 상태만 확인
#
# 먼저 ./scripts/setup.sh 를 한 번 돌려야 한다(server/real.env가 있어야 함).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REAL="$REPO/server/real.env"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

LOG_DIR="$REPO/.bosun"
BACKEND_LOG="$LOG_DIR/backend.log"

PROBLEMS=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; PROBLEMS=$((PROBLEMS + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

port_busy() { ss -ltn "sport = :$1" 2>/dev/null | tail -n +2 | grep -q . ; }
port_owner() { ss -ltnp "sport = :$1" 2>/dev/null | tail -n +2 | sed 's/.*users:((/users: (/' | head -1; }
# getval <파일> <키> — 없으면 빈 값. 실패해도 스크립트를 멈추지 않는다.
getval() {
  local file="$1" key="$2" line
  [ -f "$file" ] || return 0
  line="$(grep -m1 "^${key}=" "$file" 2>/dev/null || true)"
  printf '%s' "${line#*=}"
}

step "1. 사전 점검"
if [ ! -f "$REAL" ]; then
  bad "server/real.env가 없습니다. 먼저 ./scripts/setup.sh 를 실행하세요"
  exit 1
fi
ok "server/real.env 있음"

# real.env에서 값 읽기(비밀값은 출력하지 않는다)
AGENT_ENV_FILE="$(getval "$REAL" AGENT_ENV_FILE)"
AGENT_NAME="$(getval "$REAL" AGENT_NAME)"
AGENT_BIN="$(getval "$REAL" AGENT_BIN)"
BACKEND_PORT="$(getval "$REAL" PORT)"; BACKEND_PORT="${BACKEND_PORT:-3001}"
WEB_PORT="$(getval "$REPO/bosun.env" WEB_PORT)"; WEB_PORT="${WEB_PORT:-5173}"

[ -f "$AGENT_ENV_FILE" ] && ok "agent.env: $AGENT_ENV_FILE" || bad "agent.env가 없습니다: $AGENT_ENV_FILE"
if [ -n "$AGENT_BIN" ]; then
  [ -x "$AGENT_BIN" ] && ok "docker-agent: $("$AGENT_BIN" version 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1)" || bad "AGENT_BIN 실행 불가: $AGENT_BIN"
else
  command -v docker-agent >/dev/null 2>&1 && ok "PATH의 docker-agent 사용" || bad "docker-agent가 없습니다"
fi

if [ "$BACKEND_PORT" != "3001" ]; then
  bad "백엔드 PORT가 $BACKEND_PORT 입니다. vite.config.ts의 프록시가 http://127.0.0.1:3001 로 고정되어 있어 화면이 백엔드를 못 찾습니다(3001로 두세요)"
fi

for p in "$BACKEND_PORT" "$WEB_PORT"; do
  if port_busy "$p"; then
    warn "포트 $p 이미 사용 중 — $(port_owner "$p")"
    warn "  백엔드/화면이 이미 떠 있으면 그대로 쓰고, 아니면 정리하세요: pkill -f 'server/main.ts' / pkill -f vite"
  else
    ok "포트 $p 비어 있음"
  fi
done

# Agent 포트
AGENT_URL="$(getval "$REAL" AGENT_URL)"; AGENT_URL="${AGENT_URL:-http://127.0.0.1:8080}"
AGENT_PORT="${AGENT_URL##*:}"
if port_busy "$AGENT_PORT" && curl -sS --max-time 3 "http://127.0.0.1:$AGENT_PORT/health" >/dev/null 2>&1; then
  warn "Agent가 이미 $AGENT_PORT 에서 응답 중 — WEB은 그 Agent를 재사용합니다(토큰이 다르면 401이 납니다)"
fi

[ -d "$REPO/node_modules" ] && ok "node_modules 있음" || warn "node_modules 없음 — 이어서 npm install 합니다"

if [ "$PROBLEMS" -gt 0 ]; then
  printf '\n\033[31m%s개 문제가 있습니다.\033[0m\n' "$PROBLEMS"
  exit 1
fi
if [ "$CHECK_ONLY" = 1 ]; then
  printf '\n\033[32m확인만 했습니다. 문제 없음.\033[0m\n'
  exit 0
fi

step "2. Portainer"
if docker ps --filter name=portainer --format '{{.Names}}' 2>/dev/null | grep -q portainer; then
  ok "Portainer 실행 중"
else
  if command -v docker >/dev/null 2>&1; then
    warn "Portainer가 없습니다 → portainer/portainer-compose.yaml 로 띄웁니다"
    docker compose -f "$REPO/portainer/portainer-compose.yaml" up -d
    for i in $(seq 1 20); do
      curl -sk --max-time 2 https://localhost:9443/ >/dev/null 2>&1 && break
      sleep 1
    done
    if curl -sk --max-time 2 https://localhost:9443/ >/dev/null 2>&1; then
      ok "Portainer 응답 확인 (https://localhost:9443)"
    else
      warn "Portainer가 아직 응답하지 않습니다. 로그: docker logs portainer"
    fi
  else
    warn "docker가 없어 Portainer 단계를 건너뜁니다"
  fi
fi

step "3. 의존성"
cd "$REPO"
if [ ! -d node_modules ]; then
  if [ -f package-lock.json ]; then npm ci || npm install; else npm install; fi
fi
ok "의존성 준비 완료"

step "4. 실행"
mkdir -p "$LOG_DIR"
echo "  백엔드 로그: $BACKEND_LOG"
echo "  화면 주소:   http://localhost:$WEB_PORT   (내 PC에서 보려면 SSH 터널: -L $WEB_PORT:127.0.0.1:$WEB_PORT)"
echo "  종료:        Ctrl+C (백엔드·Agent까지 함께 종료됩니다)"
echo

npm start > "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
cleanup() {
  echo
  echo "정리 중..."
  kill "$BACKEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 백엔드가 뜰 때까지(최대 30초) 기다렸다가 화면을 띄운다
for i in $(seq 1 30); do
  if curl -sS --max-time 2 "http://127.0.0.1:$BACKEND_PORT/api/agent" >/dev/null 2>&1; then
    ok "백엔드 응답 확인 (포트 $BACKEND_PORT)"
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    bad "백엔드가 종료되었습니다. 로그를 보세요: $BACKEND_LOG"
    tail -20 "$BACKEND_LOG" || true
    exit 1
  fi
  sleep 1
done

npm run dev:http -- --port "$WEB_PORT"
