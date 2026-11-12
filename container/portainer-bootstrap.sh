#!/usr/bin/env bash
# Portainer 최초 1회 설정을 자동화한다: 관리자 계정 → 로그인(JWT) → API 키 발급 → agent.env 기록.
#
#   docker compose exec bosun /usr/local/bin/portainer-bootstrap
#
# 값은 container/.env 에서 온다(PORTAINER_ADMIN_USER/PASSWORD). 이미 같은 설명의 키가 있으면
# 새로 만들지 않고 실패한다 → 그때는 Portainer 화면(My account → Access tokens)에서 만든 값을
# container/.env 의 PORTAINER_API_KEY 에 넣고 컨테이너를 다시 올린다.
#
# Portainer가 아직 안 떠 있어도 된다: 아래 curl이 연결 거부를 재시도한다(compose에 healthcheck를
# 두지 않는 이유 — 그 이미지에 wget/curl이 없으면 healthcheck가 unhealthy로 굳어 bosun이 못 뜬다).
set -euo pipefail

P="${PORTAINER_URL_INTERNAL:-https://portainer:9443}"
U="${PORTAINER_ADMIN_USER:-admin}"
PW="${PORTAINER_ADMIN_PASSWORD:?PORTAINER_ADMIN_PASSWORD를 container/.env에 넣으세요}"
ENVF="${AGENT_ENV_FILE:-/opt/bosun/agent.env}"
DESC="${PORTAINER_TOKEN_DESC:-bosun-agent}"

api() { curl -sSk -H 'Content-Type: application/json' "$@" ; }
# 연결 거부면 최대 ~60초까지 재시도한다(HTTP 오류는 재시도하지 않는다).
api_retry() { curl -sSk --retry 20 --retry-connrefused --retry-delay 3 -H 'Content-Type: application/json' "$@"; }

echo "[0/4] Portainer 응답 대기: $P"
status="$(api_retry -o /dev/null -w '%{http_code}' "$P/api/system/status")" \
  || { echo "  Portainer에 연결하지 못했습니다 — docker compose ps / logs portainer 를 확인하세요" >&2; exit 1; }
echo "  api/system/status: HTTP $status"

# Portainer는 첫 기동 후 5분 안에 관리자 계정이 만들어지지 않으면 API를 303으로 막는다
# (Redirect-Reason: AdminInitTimeout). 이 상태는 로그인·관리자 생성이 모두 실패하므로,
# 원인이 드러나지 않는 '로그인 실패' 대신 여기서 바로 조치를 알려 준다.
if [ "$status" = "303" ] || [ "$status" = "307" ]; then
  reason="$(api_retry -D - -o /dev/null "$P/api/system/status" | tr -d '\r' \
            | awk -F': ' 'tolower($1) == "redirect-reason" { print $2 }')"
  echo "  Portainer가 초기 설정을 거부하고 있습니다 (Redirect-Reason: ${reason:-unknown})" >&2
  if [ "${reason:-}" = "AdminInitTimeout" ]; then
    echo "  → 첫 기동 5분 안에 관리자 계정을 만들지 않아 API가 막힌 상태입니다." >&2
    echo "  → 조치: docker compose restart portainer  하고, 이 스크립트를 곧바로 다시 실행하세요." >&2
  else
    echo "  → Portainer 상태를 확인하세요: docker compose ps / logs portainer" >&2
  fi
  exit 1
fi

echo "[1/4] 관리자 계정 확인/생성: $P"
# /api/users/admin/init 는 관리자가 아직 없을 때만 성공한다(있으면 409) → 실패해도 계속한다.
# 미초기화 인스턴스는 X-Setup-Token 헤더를 요구한다(없으면 403). compose 기본값은 --no-setup-token이라
# 이 헤더가 필요 없지만, 게이트를 켜 둔 경우를 위해 PORTAINER_SETUP_TOKEN을 지원한다.
setup_header=()
[ -n "${PORTAINER_SETUP_TOKEN:-}" ] && setup_header=(-H "X-Setup-Token: $PORTAINER_SETUP_TOKEN")
init_status="$(api -o /dev/null -w '%{http_code}' -X POST "$P/api/users/admin/init" \
  -d "{\"Username\":\"$U\",\"Password\":\"$PW\"}" "${setup_header[@]}")"
echo "  admin init: HTTP $init_status"
if [ "$init_status" = "403" ]; then
  echo "  Portainer가 관리자 생성을 거부했습니다(403 = setup token 필요 또는 불일치)" >&2
  echo "  → 토큰 확인:  docker logs --tail=40 bosun-portainer | grep setup_token" >&2
  echo "  → 그 값을 container/.env 의 PORTAINER_SETUP_TOKEN 에 넣고 다시 실행하거나," >&2
  echo "    docker-compose.yaml 의 portainer.command 를 --no-setup-token 으로 두세요." >&2
  exit 1
fi

echo "[2/4] 로그인(JWT)"
JWT="$(api -X POST "$P/api/auth" -d "{\"Username\":\"$U\",\"Password\":\"$PW\"}" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("jwt",""))')"
if [ -z "$JWT" ]; then
  echo "  로그인 실패 — PORTAINER_ADMIN_USER / PORTAINER_ADMIN_PASSWORD 를 확인하세요" >&2
  exit 1
fi
echo "  JWT 발급됨(8시간)"

echo "[3/4] 관리자 사용자 id 조회"
USER_ID="$(api -H "Authorization: Bearer $JWT" "$P/api/users" \
  | U="$U" python3 -c 'import json,os,sys
users = json.load(sys.stdin)
name = os.environ["U"]
print(next((u["Id"] for u in users if u.get("Username") == name or u.get("Role") == 1), ""))')"
if [ -z "$USER_ID" ]; then
  echo "  사용자를 찾지 못했습니다" >&2
  exit 1
fi
echo "  user id: $USER_ID"

echo "[4/4] API 키 발급(설명: $DESC) → $ENVF"
KEY="$(api -X POST "$P/api/users/$USER_ID/tokens" -H "Authorization: Bearer $JWT" \
      -d "{\"password\":\"$PW\",\"description\":\"$DESC\"}" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("rawAPIKey",""))')"
if [ -z "$KEY" ]; then
  echo "  키 발급 실패 — 같은 설명의 키가 이미 있는지 확인하세요(그 값은 다시 볼 수 없습니다)" >&2
  exit 1
fi

tmp="$(mktemp)"
[ -f "$ENVF" ] && grep -v -E '^PORTAINER_(URL|API_KEY)=' "$ENVF" > "$tmp" || true
printf 'PORTAINER_URL=%s\nPORTAINER_API_KEY=%s\n' "$P" "$KEY" >> "$tmp"
mv "$tmp" "$ENVF"
chmod 600 "$ENVF"

echo "  완료: $ENVF 에 PORTAINER_URL/PORTAINER_API_KEY 기록(값은 화면에 찍지 않는다)"
echo "  Agent에 반영: docker compose restart bosun"
