#!/usr/bin/env bash
# BOSUN 컨테이너 진입점.
#
#   1) agent.env를 준비한다(없을 때만 환경변수에서 시드, 권한 600)
#   2) Agent 설정을 만든다(기준 설정의 자리표시자를 컨테이너 경로로 치환, 없을 때만)
#      - AGENT_CONFIG가 폴더(기본 /opt/bosun/agents)면 초보자용·숙련자용 두 파일을 만든다 → 설정 화면에서 고를 수 있다(11-19)
#      - AGENT_NAME=agent이고 AGENT_CONFIG가 없으면 예전처럼 agent.yaml 하나(11-12 설치판)
#   3) 빠진 값이 있으면 경고한다(Agent가 죽으면 화면에는 "연결 실패"로만 보이므로 여기서 알린다)
#   4) WEB 백엔드를 실행한다(백엔드가 docker-agent를 자식 프로세스로 띄운다: AGENT_BIN)
set -euo pipefail

BOSUN_HOME="${BOSUN_HOME:-/opt/bosun}"
HOOKS_DIR="${HOOKS_DIR:-/app/ai-agent-hooks}"
AGENTS_DIR="${AGENTS_DIR:-/app/agents}"
AGENT_NAME="${AGENT_NAME:-agent}"
ENV_FILE="${AGENT_ENV_FILE:-$BOSUN_HOME/agent.env}"

# 만들 설정 파일 목록: "기준 파일|만들 파일"
if [ -n "${AGENT_CONFIG:-}" ]; then
  mkdir -p "$AGENT_CONFIG"
  YAML_PAIRS=("$AGENTS_DIR/beginner.yaml.example|$AGENT_CONFIG/beginner.yaml" "$AGENTS_DIR/expert.yaml.example|$AGENT_CONFIG/expert.yaml")
elif [ "$AGENT_NAME" = "agent" ]; then
  YAML_PAIRS=("$HOOKS_DIR/agent.yaml.example|$BOSUN_HOME/agent.yaml")
else
  YAML_PAIRS=("$AGENTS_DIR/${AGENT_NAME}.yaml.example|$BOSUN_HOME/${AGENT_NAME}.yaml")
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
  # 값이 빈 줄(`KEY=`)은 지운다: docker-agent는 그 줄을 "값이 있는 항목"으로 읽고 빈 문자열을
  # MCP 도구까지 넘긴다(그래서 Portainer가 "A valid authorization token is missing"을 돌려준다).
  # 지워 두면 컨테이너 환경변수로 넘어가거나, 최소한 "값 없음"으로 드러난다.
  if grep -qE "^${key}=[[:space:]]*$" "$ENV_FILE" 2>/dev/null; then
    log "빈 값 줄을 지웁니다: $key="
    sed -i -E "/^${key}=[[:space:]]*$/d" "$ENV_FILE"
  fi
  grep -q "^${key}=." "$ENV_FILE" || missing="$missing $key"
done
if [ -n "$missing" ]; then
  log "경고: agent.env에 빠진 값 —$missing"
  log "  container/.env에 값을 넣고 docker compose up -d 로 다시 올리거나,"
  log "  화면(http://127.0.0.1:3001) 첫 설정 페이지에서 넣으세요"
fi

# soteria 창구 주소·네트워크는 설치판이 정하는 값이라 기동마다 컨테이너 환경변수에 맞춘다.
# 훅은 SOTERIA_API·SOTERIA_NETWORK를 환경변수 → agent.env 순으로 찾는다(ai-agent-hooks/soteria_common.py).
for key in SOTERIA_API SOTERIA_NETWORK; do
  value="${!key:-}"
  [ -n "$value" ] || continue
  if [ "$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1)" != "${key}=${value}" ]; then
    sed -i -E "/^${key}=/d" "$ENV_FILE"
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    log "agent.env에 ${key}=${value}"
  fi
done

# ── 2. Agent 설정 ──────────────────────────────────────────────────────────────
for pair in "${YAML_PAIRS[@]}"; do
YAML_SRC="${pair%%|*}"
YAML_OUT="${pair#*|}"
if [ ! -f "$YAML_OUT" ]; then
  log "Agent 설정 생성(자리표시자 치환): $YAML_OUT ← $YAML_SRC"
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
  log "Agent 설정 있음(그대로 사용): $YAML_OUT"
fi

# mcp-soteria는 Agent 설정의 env로 창구 주소를 받는다. 기준 설정의 기본값(PC 직접 실행용 127.0.0.1:18090)만
# 설치판 주소로 바꾼다. 이미 있는 설정에도 적용되고, 사용자가 다른 주소로 고쳤으면 건드리지 않는다.
if [ -n "${SOTERIA_API:-}" ] && grep -q 'SOTERIA_API: "http://127.0.0.1:18090"' "$YAML_OUT"; then
  python3 - "$YAML_OUT" "$SOTERIA_API" <<'PY'
import sys

path, api = sys.argv[1:3]
text = open(path, encoding="utf-8").read()
text = text.replace('SOTERIA_API: "http://127.0.0.1:18090"', f'SOTERIA_API: "{api}"')
open(path, "w", encoding="utf-8").write(text)
PY
  log "$(basename "$YAML_OUT")의 mcp-soteria 창구 주소: $SOTERIA_API"
fi

# 백업 훅이 찾는 Portainer 환경 ID. 기준 설정은 "3"으로 고정되어 있어 환경이 다른 PC는 "지금 백업"이 실패한다(11-16·11-19 실측).
# container/.env에 SOTERIA_ENDPOINT_ID를 적으면 기동마다 그 값으로 맞춘다(손으로 sed 하던 README 단계를 대신한다).
if [ -n "${SOTERIA_ENDPOINT_ID:-}" ]; then
  if ! [[ "$SOTERIA_ENDPOINT_ID" =~ ^[0-9]+$ ]]; then
    log "오류: SOTERIA_ENDPOINT_ID는 숫자여야 합니다: $SOTERIA_ENDPOINT_ID"
    exit 1
  fi
  if grep -qE 'SOTERIA_ENDPOINT_ID: "[0-9]+"' "$YAML_OUT" && grep -E 'SOTERIA_ENDPOINT_ID: "[0-9]+"' "$YAML_OUT" | grep -vq "\"$SOTERIA_ENDPOINT_ID\""; then
    sed -i -E "s/SOTERIA_ENDPOINT_ID: \"[0-9]+\"/SOTERIA_ENDPOINT_ID: \"$SOTERIA_ENDPOINT_ID\"/" "$YAML_OUT"
    log "$(basename "$YAML_OUT")의 Portainer 환경 ID: $SOTERIA_ENDPOINT_ID"
  fi
fi
done

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
