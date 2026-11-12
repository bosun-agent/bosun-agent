#!/usr/bin/env bash
# BOSUN 준비 스크립트 — bosun.env 하나를 읽어 실행에 필요한 파일을 만들고 검사한다.
#
#   ./scripts/setup.sh              기본 설정 파일 ./bosun.env 사용
#   ./scripts/setup.sh my.env       다른 설정 파일
#   ./scripts/setup.sh --check      아무것도 만들지 않고 검사만
#
# 만드는 것: <BOSUN_HOME>/agent.env(600), <BOSUN_HOME>/agent.yaml,
#            <BOSUN_HOME>/agents/*.yaml, server/real.env(600)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$REPO/bosun.env"
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    -*) echo "알 수 없는 옵션: $arg" >&2; exit 2 ;;
    *) CONF="$arg" ;;
  esac
done

PROBLEMS=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; PROBLEMS=$((PROBLEMS + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ── 설정 읽기 ──────────────────────────────────────────
step "1. 설정 읽기"
if [ ! -f "$CONF" ]; then
  bad "설정 파일이 없습니다: $CONF
      cp bosun.env.example bosun.env  로 만들고 값을 채우세요."
  exit 1
fi
set -a; . "$CONF"; set +a
ok "설정 파일: $CONF"

: "${BOSUN_HOME:=$HOME/bosun}"
: "${AGENT_NAME:=beginner}"
: "${AGENT_MODELS:=flash}"
: "${AGENT_URL:=http://127.0.0.1:8080}"
: "${PORTAINER_URL:=https://localhost:9443}"
: "${WEB_PORT:=5173}"
BACKEND_PORT=3001   # vite.config.ts의 프록시가 3001로 고정되어 있다

# ── 값 검사 ────────────────────────────────────────────
step "2. 값 검사"
[ -n "${OPENROUTER_API_KEY:-}" ] && [ "$OPENROUTER_API_KEY" != "sk-or-..." ] \
  && ok "OPENROUTER_API_KEY 있음(길이 ${#OPENROUTER_API_KEY})" \
  || bad "OPENROUTER_API_KEY가 비어 있습니다"

[ -n "${PORTAINER_API_KEY:-}" ] \
  && ok "PORTAINER_API_KEY 있음(길이 ${#PORTAINER_API_KEY})" \
  || bad "PORTAINER_API_KEY가 비어 있습니다 (Portainer > My account > Access tokens)"

case "$BOSUN_HOME" in
  /*) ok "BOSUN_HOME=$BOSUN_HOME" ;;
  *)  bad "BOSUN_HOME은 절대경로여야 합니다: $BOSUN_HOME" ;;
esac
case "$BOSUN_HOME" in
  *" "*) bad "BOSUN_HOME에 공백이 있습니다(경로 치환·yaml이 깨집니다): $BOSUN_HOME" ;;
  "$REPO"*) warn "BOSUN_HOME이 저장소 안입니다. 실행 폴더는 저장소 밖을 권장합니다" ;;
esac

case "$AGENT_NAME" in
  agent|beginner|expert) ok "AGENT_NAME=$AGENT_NAME" ;;
  *) bad "AGENT_NAME은 agent | beginner | expert 중 하나여야 합니다: $AGENT_NAME" ;;
esac

# 모델: agent.yaml의 models 이름이거나 provider/model 형식
MODEL_PROVIDERS="openrouter openai anthropic google gemini groq ollama azure bedrock xai"
case "$AGENT_MODELS" in
  */*)
    prov="${AGENT_MODELS%%/*}"
    case " $MODEL_PROVIDERS " in
      *" $prov "*) ok "AGENT_MODELS=$AGENT_MODELS (provider=$prov)" ;;
      *) bad "AGENT_MODELS의 provider를 모르겠습니다: '$prov'
      openrouter/deepseek/deepseek-v4.1-flash 처럼 provider 접두어를 붙이거나,
      agent.yaml에 정의된 이름(flash)을 쓰세요. 접두어가 없으면 실행할 때 500이 납니다." ;;
    esac
    ;;
  *)
    KNOWN="$(python3 - "$REPO/ai-agent-hooks/agent.yaml.example" <<'PY' 2>/dev/null || true
import sys
try:
    import yaml
    cfg = yaml.safe_load(open(sys.argv[1], encoding='utf-8')) or {}
    print(' '.join((cfg.get('models') or {}).keys()))
except Exception:
    print('')
PY
)"
    case " $KNOWN " in
      *" $AGENT_MODELS "*) ok "AGENT_MODELS=$AGENT_MODELS (agent.yaml models에 정의됨)" ;;
      *) bad "AGENT_MODELS='$AGENT_MODELS' 를 agent.yaml models에서 찾지 못했습니다.
      쓸 수 있는 이름: ${KNOWN:-확인 불가(PyYAML 필요)}
      다른 모델을 쓰려면 provider/model 형식(예: openrouter/deepseek/deepseek-v4.1-flash)으로 적으세요." ;;
    esac
    ;;
esac

case "$WEB_PORT" in
  ''|*[!0-9]*) bad "WEB_PORT가 숫자가 아닙니다: $WEB_PORT" ;;
  *) ok "WEB_PORT=$WEB_PORT (백엔드는 $BACKEND_PORT 고정)" ;;
esac

# ── 도구 검사 ──────────────────────────────────────────
step "3. 도구 검사"
if command -v node >/dev/null 2>&1; then
  NV="$(node -v)"; NM="${NV#v}"; MAJ="${NM%%.*}"; MIN="$(printf '%s' "$NM" | cut -d. -f2)"
  if [ "$MAJ" -gt 22 ] || { [ "$MAJ" = 22 ] && [ "$MIN" -ge 18 ]; }; then
    ok "node $NV"
  else
    bad "node $NV — 22.18 이상이 필요합니다(vite 8이 실패합니다)"
  fi
else
  bad "node가 없습니다 (22.18 이상 설치)"
fi

if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 -V 2>&1 | awk '{print $2}')"
  if python3 -c "import yaml" 2>/dev/null; then
    ok "PyYAML 있음"
  else
    bad "PyYAML이 없습니다 — 스택 검사 훅이 모든 생성을 거부합니다
      sudo apt install python3-yaml   또는   python3 -m pip install --user pyyaml"
  fi
else
  bad "python3가 없습니다 (정책 훅이 Python)"
fi

command -v uvx >/dev/null 2>&1 && ok "uvx 있음(mcp-portainer 실행)" \
  || bad "uvx가 없습니다 — Portainer 도구가 뜨지 않습니다: curl -LsSf https://astral.sh/uv/install.sh | sh"

AGENT_BIN="${AGENT_BIN:-}"
if [ -n "$AGENT_BIN" ]; then
  [ -x "$AGENT_BIN" ] && ok "AGENT_BIN 실행 가능: $AGENT_BIN" || bad "AGENT_BIN이 실행 파일이 아닙니다: $AGENT_BIN"
elif command -v docker-agent >/dev/null 2>&1; then
  ok "PATH에서 docker-agent 발견: $(command -v docker-agent)"
else
  bad "docker-agent 실행 파일이 없습니다. bosun.env의 AGENT_BIN을 지정하거나 설치하세요
      curl -fL -o ~/bin/docker-agent https://github.com/docker/docker-agent/releases/download/v1.148.0/docker-agent-linux-amd64 && chmod +x ~/bin/docker-agent"
fi

command -v docker >/dev/null 2>&1 && ok "docker $(docker --version | awk '{print $3}' | tr -d ,)" \
  || warn "docker가 없습니다 — Portainer를 직접 띄우지 않았다면 필요합니다"

if [ "$PROBLEMS" -gt 0 ]; then
  printf '\n\033[31m%s개 문제가 있습니다. 위 항목을 고친 뒤 다시 실행하세요.\033[0m\n' "$PROBLEMS"
  exit 1
fi

if [ "$CHECK_ONLY" = 1 ]; then
  printf '\n\033[32m검사만 수행했습니다. 문제 없음.\033[0m\n'
  exit 0
fi

# ── 파일 만들기 ────────────────────────────────────────
step "4. 파일 만들기"
mkdir -p "$BOSUN_HOME/agents"

# (1) agent.env — Agent와 훅이 읽는 비밀값
umask 077
cat > "$BOSUN_HOME/agent.env" <<EOF
# scripts/setup.sh가 생성. 커밋 금지. 권한 600.
OPENROUTER_API_KEY=$OPENROUTER_API_KEY
PORTAINER_URL=$PORTAINER_URL
PORTAINER_API_KEY=$PORTAINER_API_KEY
TELEMETRY_ENABLED=false
EOF
chmod 600 "$BOSUN_HOME/agent.env"
ok "agent.env (600, $(wc -c < "$BOSUN_HOME/agent.env") bytes)"

# (2) agent.yaml — /절대경로/·/실행폴더/ 자리표시자를 python3로 정확히 치환한다.
#     (sed로 하면 실행 폴더 끝 슬래시가 빠졌을 때 경로가 붙어버린다: agent-runagent.env)
python3 - "$REPO/ai-agent-hooks/agent.yaml.example" "$BOSUN_HOME/agent.yaml" "$REPO/ai-agent-hooks" "$BOSUN_HOME" <<'PY'
import pathlib, re, sys
src, dst, hooks, home = sys.argv[1], sys.argv[2], sys.argv[3].rstrip('/'), sys.argv[4].rstrip('/')
text = pathlib.Path(src).read_text(encoding='utf-8')
text = text.replace('/절대경로/', hooks + '/').replace('/실행폴더/', home + '/')
pathlib.Path(dst).write_text(text, encoding='utf-8')

bad = []
for marker in ('/절대경로/', '/실행폴더/'):
    if marker in text:
        bad.append(f'치환되지 않은 자리표시자: {marker}')
for base in (hooks, home):
    for m in re.finditer(re.escape(base) + r'[^/\s"]', text):
        bad.append(f'경로가 붙어버린 곳: {m.group(0)}')
if bad:
    print('FAIL: ' + '; '.join(sorted(set(bad))), file=sys.stderr)
    sys.exit(1)
PY
ok "agent.yaml (경로 치환 검증 통과)"

# (3) agents/*.yaml — beginner/expert는 기준 설정에서 만든다
if [ "$AGENT_NAME" = "agent" ]; then
  warn "AGENT_NAME=agent 이므로 agents/ 는 만들지 않습니다"
else
  python3 "$REPO/ai-agent-hooks/tools/make_agents.py" "$BOSUN_HOME/agent.yaml" "$BOSUN_HOME/agents" >/dev/null
  python3 - "$BOSUN_HOME/agents" "$REPO/ai-agent-hooks" "$BOSUN_HOME" <<'PY'
import pathlib, re, sys
agents_dir, hooks, home = sys.argv[1], sys.argv[2].rstrip('/'), sys.argv[3].rstrip('/')
bad = []
for f in sorted(pathlib.Path(agents_dir).glob('*.yaml')):
    text = f.read_text(encoding='utf-8')
    for marker in ('/절대경로/', '/실행폴더/'):
        if marker in text:
            bad.append(f'{f.name}: {marker}')
    for base in (hooks, home):
        bad += [f'{f.name}: {m.group(0)}' for m in re.finditer(re.escape(base) + r'[^/\s"]', text)]
if bad:
    print('FAIL: ' + '; '.join(sorted(set(bad))), file=sys.stderr)
    sys.exit(1)
PY
  ok "agents/ ($(ls "$BOSUN_HOME/agents" | tr '\n' ' '))"
fi

# (4) server/real.env — WEB 백엔드 설정
REAL="$REPO/server/real.env"
if [ -f "$REAL" ]; then
  cp "$REAL" "$REAL.bak-$(date +%Y%m%d%H%M%S)"
  warn "기존 real.env를 백업하고 새로 씁니다"
fi
TOKEN="$(node -e "console.log(crypto.randomUUID())")"
umask 077
{
  echo "# scripts/setup.sh가 생성. 커밋 금지(권한 600)."
  echo "# 값의 출처: $(basename "$CONF")"
  echo "HOST=127.0.0.1"
  echo "PORT=$BACKEND_PORT"
  echo "AGENT_BIN=$AGENT_BIN"
  echo "AGENT_ENV_FILE=$BOSUN_HOME/agent.env"
  [ "$AGENT_NAME" = "agent" ] || echo "AGENT_CONFIG=$BOSUN_HOME/agents"
  echo "AGENT_NAME=$AGENT_NAME"
  echo "AGENT_URL=$AGENT_URL"
  echo "AGENT_TOKEN=$TOKEN"
  echo "AGENT_MODELS=$AGENT_MODELS"
  echo "PORTAINER_URL=$PORTAINER_URL"
  echo "TELEMETRY_ENABLED=false"
} > "$REAL"
chmod 600 "$REAL"
ok "server/real.env (600, AGENT_TOKEN 새로 생성)"

# ── 만든 파일 다시 검사 ────────────────────────────────
step "5. 만든 파일 검사"
if python3 -c "import yaml" 2>/dev/null; then
  CHECK="$BOSUN_HOME/agent.yaml"
  [ "$AGENT_NAME" = "agent" ] || CHECK="$BOSUN_HOME/agents/$AGENT_NAME.yaml"
  if python3 "$REPO/ai-agent-hooks/tools/check_merged_config.py" "$CHECK" "$REPO/ai-agent-hooks/agent.yaml.example" >/dev/null 2>&1; then
    ok "설정 검사 통과(훅·권한이 기준과 일치)"
  else
    bad "설정 검사 실패: python3 ai-agent-hooks/tools/check_merged_config.py $CHECK ai-agent-hooks/agent.yaml.example"
  fi
fi

if REPO_HOOKS="$REPO/ai-agent-hooks" AGENT_ENV_FILE="$BOSUN_HOME/agent.env" python3 - <<'PY'
import os, sys
sys.path.insert(0, os.environ['REPO_HOOKS'])
import portainer_api
vals = portainer_api._read_env_file(os.environ['AGENT_ENV_FILE'])
sys.exit(0 if vals.get('PORTAINER_API_KEY') and vals.get('OPENROUTER_API_KEY') else 1)
PY
then
  ok "훅이 agent.env를 읽을 수 있음"
else
  bad "훅이 agent.env를 읽지 못합니다(경로·권한 확인)"
fi

if [ "$PROBLEMS" -gt 0 ]; then
  printf '\n\033[31m%s개 문제가 있습니다.\033[0m\n' "$PROBLEMS"
  exit 1
fi

printf '\n\033[32m준비 끝.\033[0m 다음: ./scripts/up.sh\n'
printf '  실행 폴더: %s\n  백엔드 설정: %s\n' "$BOSUN_HOME" "$REAL"
