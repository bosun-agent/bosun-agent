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
api_retry -o /dev/null -w '  api/system/status: HTTP %{http_code}\n' "$P/api/system/status" \
  || { echo "  Portainer에 연결하지 못했습니다 — docker compose ps / logs bosun-portainer 를 확인하세요" >&2; exit 1; }

echo "[1/4] 관리자 계정 확인/생성: $P"
# /api/users/admin/init 는 관리자가 아직 없을 때만 성공한다(이미 있으면 409) → 실패해도 계속한다.
api -o /dev/null -w '  admin init: HTTP %{http_code}\n' \
  -X POST "$P/api/users/admin/init" \
  -d "{\"Username\":\"$U\",\"Password\":\"$PW\"}" || true

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
