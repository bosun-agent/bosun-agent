#!/usr/bin/env bash
# BOSUN 컨테이너 진입점.
#
#   1) agent.env를 준비한다(없을 때만 환경변수에서 시드, 권한 600)
#   2) agent.yaml을 만든다(기준 설정의 자리표시자를 컨테이너 경로로 치환, 없을 때만)
#   3) 빠진 값이 있으면 경고한다(Agent가 죽으면 화면에는 "연결 실패"로만 보이므로 여기서 알린다)
#   4) WEB 백엔드를 실행한다(백엔드가 docker-agent를 자식 프로세스로 띄운다: AGENT_BIN)
set -euo pipefail

BOSUN_HOME="${BOSUN_HOME:-/opt/bosun}"
HOOKS_DIR="${HOOKS_DIR:-/app/ai-agent-hooks}"
AGENTS_DIR="${AGENTS_DIR:-/app/agents}"
AGENT_NAME="${AGENT_NAME:-agent}"
ENV_FILE="${AGENT_ENV_FILE:-$BOSUN_HOME/agent.env}"
YAML_OUT="$BOSUN_HOME/${AGENT_NAME}.yaml"

# 기준 설정: agent 는 직접 연결 기준 설정(ai-agent-hooks), beginner/expert 는 agents/ 사본
if [ "$AGENT_NAME" = "agent" ]; then
  YAML_SRC="$HOOKS_DIR/agent.yaml.example"
else
  YAML_SRC="$AGENTS_DIR/${AGENT_NAME}.yaml.example"
fi

log() { printf '[entrypoint] %s\n' "$*"; }

mkdir -p "$BOSUN_HOME"

# ── 1. agent.env ────────────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  log "agent.env 생성(환경변수에서 시드): $ENV_FILE"
  : > "$ENV_FILE"
  # Agent·훅이 쓰는 Portainer 주소는 스택 내부 주소다(브라우저용 PORTAINER_URL과 다르다).
  internal="${PORTAINER_URL_INTERNAL:-$PORTAINER_URL}"
  for pair in "OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}" \
              "PORTAINER_URL=$internal" \
              "PORTAINER_API_KEY=${PORTAINER_API_KEY:-}"; do
    key="${pair%%=*}"; value="${pair#*=}"
    [ -n "$value" ] && printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  done
  chmod 600 "$ENV_FILE"
else
  log "agent.env 있음(그대로 사용): $ENV_FILE"
fi

missing=""
for key in OPENROUTER_API_KEY PORTAINER_URL PORTAINER_API_KEY; do
  grep -q "^${key}=." "$ENV_FILE" || missing="$missing $key"
done
if [ -n "$missing" ]; then
  log "경고: agent.env에 빠진 값 —$missing"
  log "  container/.env를 채우고 docker compose up -d 로 다시 올리세요(또는 portainer-bootstrap 실행)"
fi

# ── 2. agent.yaml ──────────────────────────────────────────────────────────────
if [ ! -f "$YAML_OUT" ]; then
  log "agent.yaml 생성(자리표시자 치환): $YAML_OUT ← $YAML_SRC"
  if [ ! -f "$YAML_SRC" ]; then
    log "오류: 기준 설정이 없습니다: $YAML_SRC (AGENT_NAME=$AGENT_NAME)"
    exit 1
  fi
  python3 - "$YAML_SRC" "$YAML_OUT" "$BOSUN_HOME" "$HOOKS_DIR" <<'PY'
import re
import sys

src, out, home, hooks = sys.argv[1:5]
text = open(src, encoding="utf-8").read()

# /절대경로/ = 훅 폴더, /실행폴더/ = agent.env가 있는 폴더(치환값 끝 슬래시가 빠지면 경로가 붙는다)
text = text.replace("/절대경로/", hooks.rstrip("/") + "/")
text = text.replace("/실행폴더/", home.rstrip("/") + "/")

# 이미지에는 mcp-portainer를 고정 설치했다 → 런타임 uvx 대신 콘솔 스크립트를 쓴다
text, n = re.subn(
    r'command: uvx\s*\n\s*args: \["--from",\s*"mcp-portainer==[^"]+",\s*"mcp-portainer"\]',
    "command: mcp-portainer",
    text,
)
if n != 1:
    sys.exit(f"mcp-portainer 도구 등록(command: uvx …)을 찾지 못했습니다(n={n}). 기준 설정이 바뀌었는지 확인하세요")

leftovers = [p for p in ("/절대경로/", "/실행폴더/", "uvx") if p in text]
if leftovers:
    sys.exit("치환이 남았습니다: " + ", ".join(leftovers) + " — 그대로 두면 훅이 전부 차단합니다")

open(out, "w", encoding="utf-8").write(text)
print(f"[entrypoint] wrote {out} ({len(text.splitlines())} lines)")
PY
else
  log "agent.yaml 있음(그대로 사용): $YAML_OUT"
fi

# ── 3. WEB ↔ Agent 토큰 ────────────────────────────────────────────────────────
# 루프백에서만 오가는 값이라 외부에 노출되지 않는다. 비어 있으면 이번 기동용으로 만든다.
if [ -z "${AGENT_TOKEN:-}" ]; then
  AGENT_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  export AGENT_TOKEN
  log "AGENT_TOKEN 생성(이번 기동용, container/.env에 넣으면 고정된다)"
fi

# ── 4. WEB 백엔드 ──────────────────────────────────────────────────────────────
log "실행: node server/main.ts (agent: ${AGENT_URL:-http://127.0.0.1:8080})"
exec node server/main.ts
