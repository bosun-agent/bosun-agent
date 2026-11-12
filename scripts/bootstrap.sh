#!/usr/bin/env bash
# BOSUN 환경 구축 스크립트 — 실행에 필요한 것들을 설치한다(Ubuntu 22.04/24.04, Debian 기준).
#
#   ./scripts/bootstrap.sh            빠진 것만 설치
#   ./scripts/bootstrap.sh --check    설치하지 않고 무엇이 빠졌는지 확인만
#
# 이미 있는 것은 건드리지 않는다(멱등). 관리자 권한이 필요한 단계는 sudo를 쓰고,
# sudo가 없으면 그 단계만 건너뛰고 무엇을 직접 해야 하는지 알려준다.
set -uo pipefail   # 개별 단계가 실패해도 전체 점검은 끝까지 한다

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

# 설치 위치(테스트용으로 바꿀 수 있게 분리)
PREFIX="${BOSUN_PREFIX:-/usr/local}"        # node 등 시스템 도구
BIN_DIR="${BOSUN_BIN_DIR:-$HOME/bin}"       # docker-agent
NODE_VER="${BOSUN_NODE_VER:-22.23.4}"       # Node 22 LTS (저장소 요구: >=22.18)
AGENT_VER="${BOSUN_AGENT_VER:-1.148.0}"     # 팀 고정 버전

PROBLEMS=0; INSTALLED=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
did()  { printf '  \033[36m+\033[0m %s\n' "$1"; INSTALLED=$((INSTALLED + 1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; PROBLEMS=$((PROBLEMS + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

if [ "$(id -u)" = 0 ]; then SUDO=""; elif command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else SUDO=""; fi
apt_do() {  # apt_do <설명> <패키지...>
  local what="$1"; shift
  if [ -z "$SUDO" ] && [ "$(id -u)" != 0 ]; then
    bad "$what — 설치에 관리자 권한이 필요합니다. 직접 실행하세요: sudo apt install -y $*"
    return 1
  fi
  if $SUDO apt-get install -y -q "$@" >/dev/null 2>&1; then
    did "$what 설치"
  else
    bad "$what 설치 실패 — 직접 실행해 보세요: sudo apt install -y $*"
    return 1
  fi
}

# ── 0. 환경 ────────────────────────────────────────────
step "0. 환경 확인"
case "$(uname -s)" in Linux) ok "Linux" ;; *) warn "리눅스가 아닙니다: $(uname -s) — 이 스크립트는 Ubuntu/Debian 기준입니다" ;; esac
ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64) NODE_ARCH=x64;  AGENT_ARCH=amd64 ;;
  aarch64|arm64) NODE_ARCH=arm64; AGENT_ARCH=arm64 ;;
  *) bad "지원하지 않는 아키텍처: $ARCH_RAW"; NODE_ARCH=x64; AGENT_ARCH=amd64 ;;
esac
if [ -n "$SUDO" ] || [ "$(id -u)" = 0 ]; then ok "관리자 권한 사용 가능(sudo)"; else warn "sudo가 없어 시스템 패키지 설치 단계는 안내만 합니다"; fi

if command -v apt-get >/dev/null 2>&1; then
  [ "$CHECK_ONLY" = 1 ] || { $SUDO apt-get update -q >/dev/null 2>&1 && ok "apt 목록 갱신" || warn "apt update 실패(사내 미러 문제일 수 있음)"; }
fi

# ── 1. 기본 도구 ───────────────────────────────────────
step "1. 기본 도구"
for c in curl tar xz python3; do
  if command -v "$c" >/dev/null 2>&1; then
    ok "$c"
  elif [ "$CHECK_ONLY" = 1 ]; then
    bad "$c 없음"
  else
    apt_do "$c" "$c" >/dev/null && ok "$c"
  fi
done

if python3 -c "import yaml" 2>/dev/null; then
  ok "PyYAML"
elif [ "$CHECK_ONLY" = 1 ]; then
  bad "PyYAML 없음(스택 검사 훅이 모든 생성을 거부)"
else
  apt_do "PyYAML" python3-yaml || {
    if python3 -m pip --version >/dev/null 2>&1; then
      python3 -m pip install --user -q pyyaml >/dev/null 2>&1 && did "PyYAML(pip --user)" || bad "PyYAML 설치 실패"
    else
      bad "PyYAML 설치 실패 — python3-pip 또는 python3-yaml을 직접 설치하세요"
    fi
  }
fi

if command -v uvx >/dev/null 2>&1 || [ -x "$HOME/.local/bin/uvx" ]; then
  ok "uv($(uv --version 2>/dev/null))"
elif [ "$CHECK_ONLY" = 1 ]; then
  bad "uv/uvx 없음(mcp-portainer가 뜨지 않음)"
else
  if curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1; then
    export PATH="$HOME/.local/bin:$PATH"
    did "uv 설치 — 새 셸에서 PATH에 ~/.local/bin 이 있어야 합니다"
  else
    bad "uv 설치 실패 — 직접: curl -LsSf https://astral.sh/uv/install.sh | sh"
  fi
fi

# ── 2. Node 22.18 이상 ────────────────────────────────
step "2. Node.js"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v maj min
  v="$(node -v)"; v="${v#v}"; maj="${v%%.*}"; min="$(printf '%s' "$v" | cut -d. -f2)"
  [ "$maj" -gt 22 ] || { [ "$maj" = 22 ] && [ "$min" -ge 18 ]; }
}
if node_ok 2>/dev/null; then
  ok "node $(node -v) — 요구(>=22.18) 충족"
elif [ "$CHECK_ONLY" = 1 ]; then
  bad "node $(node -v 2>/dev/null || echo 없음) — 22.18 이상 필요(vite 8이 실패)"
else
  warn "node $(node -v 2>/dev/null || echo 없음) → $NODE_VER 로 설치/업그레이드"
  TARBALL="node-v${NODE_VER}-linux-${NODE_ARCH}.tar.xz"
  TMPD="$(mktemp -d)"
  if curl -fL --progress-bar "https://nodejs.org/dist/v${NODE_VER}/${TARBALL}" -o "$TMPD/$TARBALL"; then
    if [ -n "$SUDO" ] || [ "$(id -u)" = 0 ]; then
      $SUDO mkdir -p "$PREFIX"
      $SUDO tar -xJf "$TMPD/$TARBALL" -C "$PREFIX" --strip-components=1
      hash -r
      node_ok && did "Node $(node -v) 설치($PREFIX)" || bad "Node 설치 후에도 버전이 낮습니다 — PATH 확인: which -a node"
    else
      USER_PREFIX="${BOSUN_USER_PREFIX:-$HOME/.local/node}"
      mkdir -p "$USER_PREFIX"
      tar -xJf "$TMPD/$TARBALL" -C "$USER_PREFIX" --strip-components=1
      did "Node $NODE_VER 설치($USER_PREFIX) — PATH에 넣으세요: export PATH=\"$USER_PREFIX/bin:\$PATH\""
    fi
    if command -v node >/dev/null 2>&1; then
      case "$(command -v node)" in
        /usr/bin/node) warn "apt의 옛 node($(node -v))가 앞에 있습니다. sudo apt purge -y nodejs npm 후 hash -r" ;;
      esac
    fi
  else
    bad "Node 내려받기 실패 — 네트워크 확인"
  fi
  rm -rf "$TMPD"
fi

# ── 3. docker-agent ───────────────────────────────────
step "3. docker-agent"
AGENT_BIN_FOUND=""
if [ -x "${AGENT_BIN:-}" ]; then AGENT_BIN_FOUND="$AGENT_BIN"
elif command -v docker-agent >/dev/null 2>&1; then AGENT_BIN_FOUND="$(command -v docker-agent)"
elif [ -x "$BIN_DIR/docker-agent" ]; then AGENT_BIN_FOUND="$BIN_DIR/docker-agent"
fi

if [ -n "$AGENT_BIN_FOUND" ]; then
  ok "docker-agent $("$AGENT_BIN_FOUND" version 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1) — $AGENT_BIN_FOUND"
elif [ "$CHECK_ONLY" = 1 ]; then
  bad "docker-agent 없음 (팀 고정 v$AGENT_VER)"
else
  mkdir -p "$BIN_DIR"
  URL="https://github.com/docker/docker-agent/releases/download/v${AGENT_VER}/docker-agent-linux-${AGENT_ARCH}"
  if curl -fL --progress-bar "$URL" -o "$BIN_DIR/docker-agent"; then
    chmod +x "$BIN_DIR/docker-agent"
    did "docker-agent v$AGENT_VER 설치 — $BIN_DIR/docker-agent ($("$BIN_DIR/docker-agent" version 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1))"
    case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "PATH에 $BIN_DIR 이 없습니다. bosun.env의 AGENT_BIN에 $BIN_DIR/docker-agent 를 적으면 됩니다" ;; esac
  else
    bad "docker-agent 내려받기 실패 — $URL"
  fi
fi

# ── 4. Docker + Portainer ─────────────────────────────
step "4. Docker(선택 — Portainer를 이 PC에서 띄울 때)"
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok "docker 실행 중 ($(docker --version | awk '{print $3}' | tr -d ,))"
  else
    warn "docker 명령은 있으나 데몬에 연결되지 않습니다 — sudo systemctl start docker / docker 그룹 가입 후 재로그인"
    id -nG 2>/dev/null | tr ' ' '\n' | grep -qx docker || warn "  현재 사용자가 docker 그룹이 아닙니다: sudo usermod -aG docker \$USER"
  fi
  if docker compose version >/dev/null 2>&1; then
    ok "docker compose v2"
  elif [ "$CHECK_ONLY" = 1 ]; then
    bad "docker compose v2 없음"
  else
    apt_do "docker compose v2" docker-compose-v2 || warn "배포판 패키지가 없으면 Docker 공식 저장소의 docker-compose-plugin을 설치하세요"
  fi
else
  if [ "$CHECK_ONLY" = 1 ]; then
    warn "docker 없음 — 다른 PC의 Portainer를 쓰려면 없어도 됩니다(bosun.env의 PORTAINER_URL을 그 주소로)"
  else
    apt_do "docker" docker.io && apt_do "docker compose v2" docker-compose-v2 || true
    warn "docker 그룹 가입 후 재로그인해야 sudo 없이 씁니다: sudo usermod -aG docker \$USER"
  fi
fi

# ── 마무리 ────────────────────────────────────────────
step "결과"
printf '  설치/변경: %s개   남은 문제: %s개\n' "$INSTALLED" "$PROBLEMS"
if [ "$CHECK_ONLY" = 1 ]; then
  printf '\n확인만 했습니다. 설치하려면: ./scripts/bootstrap.sh\n'
  exit 0
fi
if [ "$PROBLEMS" -gt 0 ]; then
  printf '\n\033[31m위 ✗ 항목을 해결한 뒤 다시 실행하세요.\033[0m\n'
  exit 1
fi
printf '\n\033[32m환경 준비 완료.\033[0m 다음 순서:\n'
printf '  1) cp bosun.env.example bosun.env  → 키 2개 채우기\n'
printf '  2) ./scripts/setup.sh              (실행 파일 3종 생성 + 검사)\n'
printf '  3) ./scripts/up.sh                 (Portainer → 백엔드 → 화면)\n'
