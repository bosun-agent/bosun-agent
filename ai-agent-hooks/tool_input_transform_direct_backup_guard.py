#!/usr/bin/env python3
"""
[직접 연결용] tool_input_transform 훅 — 삭제 전 백업 (Airlock 없이 Docker Agent → mcp-portainer 구조)

하는 일
  docker_proxy 호출 중 method가 DELETE인 것만 가로채, 삭제 대상의 inspect 결과를
  Portainer REST API에서 직접 조회해 SQLite에 저장한다. 저장에 성공해야 통과시킨다.
  - 컨테이너  DELETE /containers/{id}   → GET /containers/{id}/json
  - (10/31부터) 이미지·네트워크 DELETE는 정책 훅과 deny가 막으므로 백업하지 않고 그냥 넘긴다.
  - 컨테이너 DELETE에 v=true(익명 볼륨 함께 삭제)가 있으면 백업할 수 없으므로 차단한다.
  - 대상을 알 수 없는 DELETE, 조회·저장 실패, 예외 → 모두 차단(fail-closed).
  볼륨 삭제와 prune은 agent.yaml의 deny로 이미 막혀 있다.

실행 시점(docker-agent v1.148.0 소스 approveAndRun 기준)
  tool_input_transform → tool_guard → 권한 판정 → 사용자 승인 → 실행.
  승인 후·실행 전에 도는 훅이 없으므로 승인 전에 백업한다. 사람이 거부해도 백업은 남는다.

키 전달
  훅은 --env-from-file 값을 받지 못한다(v1.145.0·v1.148.0 실행 확인).
  그래서 훅 env의 AGENT_ENV_FILE(agent.env 경로)을 직접 읽어 PORTAINER_URL, PORTAINER_API_KEY를 얻는다.
  같은 이름의 환경변수가 이미 있으면 그것을 먼저 쓴다(터미널 export 대응).

입출력
  입력(stdin JSON): {"tool_name": "...", "tool_input": {...}, "session_id": "...", ...}
  출력(stdout JSON): 통과 {} / 차단 {"decision": "block", "reason": "<사유>"}

agent.yaml 등록(반드시 on_error: block):
  tool_input_transform:
    - matcher: "docker_proxy"
      hooks:
        - type: command
          command: python3 /절대경로/tool_input_transform_direct_backup_guard.py
          timeout: 30
          on_error: block
          env:
            AGENT_ENV_FILE: /실행폴더/agent.env
            PORTAINER_TLS_VERIFY: "0"

환경변수(선택)
  AI_AGENT_BACKUP_DB   저장 위치. 기본값: AGENT_ENV_FILE과 같은 폴더의 backups.sqlite3
  BACKUP_TTL_DAYS      보존 기간(일). 기본 30. 0이면 삭제하지 않음
표준 라이브러리만 사용한다.
"""
import json
import os
import re
import sqlite3
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

TRUE_VALUES = {"1", "true", "yes", "on"}


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))


def block(reason):
    out({"decision": "block", "reason": "삭제 전 백업에 실패하여 요청을 거부했습니다: " + reason})


def read_env_file(path):
    values = {}
    if not path:
        return values
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key.startswith("export "):
                key = key[len("export "):].strip()
            values[key] = value.strip().strip('"').strip("'")
    return values


def setting(name, file_values, default=None):
    return os.environ.get(name) or file_values.get(name) or default


def parse_target(path):
    """path → (종류, 대상, inspect 경로, path 안의 query dict). 모르면 (None, ...)."""
    parsed = urllib.parse.urlsplit(path)
    clean = re.sub(r"^/v\d+(\.\d+)?", "", parsed.path).rstrip("/")
    inline_query = {k: v[-1] for k, v in urllib.parse.parse_qs(parsed.query).items()}
    m = re.fullmatch(r"/containers/([^/]+)", clean)
    if m:
        return "container", m.group(1), f"/containers/{m.group(1)}/json", inline_query
    m = re.fullmatch(r"/networks/([^/]+)", clean)
    if m:
        return "network", m.group(1), f"/networks/{m.group(1)}", inline_query
    m = re.fullmatch(r"/images/(.+)", clean)
    if m and not m.group(1).endswith("/json"):
        return "image", m.group(1), f"/images/{m.group(1)}/json", inline_query
    return None, None, None, inline_query


def fetch_inspect(base_url, api_key, verify, environment_id, inspect_path):
    url = f"{base_url.rstrip('/')}/api/endpoints/{environment_id}/docker{inspect_path}"
    req = urllib.request.Request(url, headers={"X-API-Key": api_key}, method="GET")
    ctx = ssl.create_default_context()
    if not verify:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
            return resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"Portainer 조회 실패(HTTP {e.code}): {body}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"Portainer에 연결하지 못했습니다: {e.reason}") from None


def save(db_path, row, ttl_days):
    new = not os.path.exists(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS backups (ts REAL, time TEXT, session_id TEXT, environment_id TEXT,"
            " method TEXT, path TEXT, query_json TEXT, kind TEXT, target TEXT, inspect_json TEXT)"
        )
        conn.execute("INSERT INTO backups VALUES (?,?,?,?,?,?,?,?,?,?)", row)
        if ttl_days > 0:
            conn.execute("DELETE FROM backups WHERE ts < ?", (time.time() - ttl_days * 86400,))
        conn.commit()
    finally:
        conn.close()
    if new:
        os.chmod(db_path, 0o600)


def main():
    raw = sys.stdin.read().strip()
    payload = json.loads(raw) if raw else {}
    if payload.get("tool_name") != "docker_proxy":
        out({})
        return
    args = payload.get("tool_input") or {}
    method = str(args.get("method") or "GET").upper()
    if method != "DELETE":
        out({})
        return

    path = str(args.get("path") or "")
    environment_id = args.get("environment_id")
    kind, target, inspect_path, inline_query = parse_target(path)
    query = dict(inline_query)
    if isinstance(args.get("query_params"), dict):
        query.update({str(k): str(v) for k, v in args["query_params"].items()})

    if kind is None:
        block(f"삭제 대상을 식별할 수 없습니다(path={path}).")
        return
    if kind in ("image", "network"):
        out({})  # 10/31: 이미지·네트워크 삭제는 정책 훅과 deny가 막는다. 실행되지 않을 삭제는 백업하지 않는다.
        return
    if environment_id in (None, ""):
        block("environment_id가 없습니다.")
        return
    if kind == "container" and str(query.get("v", "")).strip().lower() in TRUE_VALUES:
        block("v=true는 컨테이너의 익명 볼륨까지 삭제하며 볼륨 데이터는 백업할 수 없습니다. v 없이 다시 요청하세요.")
        return

    env_file = os.environ.get("AGENT_ENV_FILE", "")
    file_values = read_env_file(env_file)
    base_url = setting("PORTAINER_URL", file_values)
    api_key = setting("PORTAINER_API_KEY", file_values)
    if not base_url or not api_key:
        block("PORTAINER_URL 또는 PORTAINER_API_KEY를 찾지 못했습니다(AGENT_ENV_FILE 확인).")
        return
    verify = str(setting("PORTAINER_TLS_VERIFY", file_values, "1")).strip().lower() not in {"0", "false", "no", "off"}

    inspect_json = fetch_inspect(base_url, api_key, verify, environment_id, inspect_path)
    json.loads(inspect_json)  # 응답이 JSON인지 확인

    default_db = os.path.join(os.path.dirname(os.path.abspath(env_file)) if env_file else os.path.dirname(os.path.abspath(__file__)), "backups.sqlite3")
    db_path = os.environ.get("AI_AGENT_BACKUP_DB", default_db)
    ttl_days = int(os.environ.get("BACKUP_TTL_DAYS", "30"))
    now = time.time()
    save(db_path, (now, time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)), str(payload.get("session_id", "")),
                   str(environment_id), method, path, json.dumps(query, ensure_ascii=False), kind, target, inspect_json), ttl_days)
    sys.stderr.write(f"backup saved: {kind} {target} -> {db_path}\n")
    out({})


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — 어떤 오류든 차단(fail-closed)
        block(str(exc)[:300])
