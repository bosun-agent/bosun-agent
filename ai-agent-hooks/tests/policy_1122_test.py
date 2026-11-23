#!/usr/bin/env python3
"""
11/22 웹 시험 후속 테스트
  - N: 네트워크 삭제 전 설정 기록. 남기면 좋지만, 남기지 못해도 삭제는 막지 않는다(네트워크엔 데이터가 없다)
  - C: 같은 조건에서 컨테이너 삭제는 지금처럼 막는다(fail-closed 그대로)
  - S: backup_status job_id — 정책표 5.9대로 없음·빈 값·비정상 값은 모두 거부(형식 맞는 작업 1건만 조회)
  - G: 관리 컨테이너 거부 안내가 역할(Portainer·백업용·설치판)에 맞는 이유를 고른다
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fake_portainer  # noqa: E402,F401

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, D)
BACKUP = os.path.join(D, "tool_input_transform_direct_backup_guard.py")
SOTERIA = os.path.join(D, "tool_input_transform_soteria_guard.py")
DB = os.path.join(tempfile.mkdtemp(), "backups.sqlite3")
results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print(("OK  " if ok else "XX  ") + name + ("" if ok else f"  (결과 {got}, 기대 {want})"))


def hook(path, payload, extra_env=None):
    env = {**os.environ, "AI_AGENT_BACKUP_DB": DB, **(extra_env or {})}
    r = subprocess.run([sys.executable, "-X", "utf8", path], input=json.dumps(payload), capture_output=True, text=True, env=env)
    o = json.loads(r.stdout or "{}")
    return ("block" if o.get("decision") == "block" else ("rewrite" if o.get("hook_specific_output") else "pass")), o


def delete(path, extra_env=None):
    return hook(BACKUP, {"tool_name": "docker_proxy", "tool_input": {"environment_id": 3, "method": "DELETE", "path": path}}, extra_env)


def rows(kind):
    if not os.path.exists(DB):
        return 0
    with sqlite3.connect(DB) as c:
        return c.execute("SELECT COUNT(*) FROM backups WHERE kind = ?", (kind,)).fetchone()[0]


fake_portainer.NETWORKS["appnet"] = {"Name": "appnet", "Id": "a" * 64, "Driver": "bridge", "Containers": {}}

DOWN = {"PORTAINER_URL": "http://127.0.0.1:9"}   # 닫힌 포트 → 조회 실패

check("N1 네트워크 삭제: 조회되면 통과하고 기록을 남김", delete("/networks/appnet")[0], "pass")
check("N2 네트워크 기록 1건", rows("network"), 1)
check("N3 Portainer 조회 실패여도 네트워크 삭제는 통과", delete("/networks/appnet", DOWN)[0], "pass")
check("N4 실패한 건은 기록하지 않음", rows("network"), 1)
check("N5 environment_id가 없어도 네트워크 삭제는 통과",
      hook(BACKUP, {"tool_name": "docker_proxy", "tool_input": {"method": "DELETE", "path": "/networks/appnet"}})[0], "pass")
check("C1 Portainer 조회 실패면 컨테이너 삭제는 여전히 거부", delete("/containers/web-old", DOWN)[0], "block")
check("C2 environment_id가 없으면 컨테이너 삭제는 여전히 거부",
      hook(BACKUP, {"tool_name": "docker_proxy", "tool_input": {"method": "DELETE", "path": "/containers/web-old"}})[0], "block")
check("C3 알 수 없는 삭제 경로는 여전히 거부", delete("/plugins/x")[0], "block")

LIST = "bosun-list-00000000T000000-000000"
for v in (None, "", "null", "None", " NULL ", "undefined", "test22w", "latest", LIST, "../x", "a b", "x;rm"):
    check(f"S job_id {v!r} → 거부", hook(SOTERIA, {"tool_name": "backup_status", "tool_input": {"job_id": v}})[0], "block")
check("S 형식 맞는 job_id는 그대로", hook(SOTERIA, {"tool_name": "backup_status", "tool_input": {"job_id": "bosun-x-20261122T000000-abcdef"}})[0], "pass")

import deny_guide  # noqa: E402
import tool_input_transform_direct_policy_guard as g  # noqa: E402
for name, want in (("portainer", "Portainer)가 멈추면"), ("bosun-soteria-soteria-1", "백업이 멈춥니다"),
                   ("bosun-backup", "백업이 멈춥니다"), ("bosun", "BOSUN 자신")):
    r = deny_guide.proxy_reason("x", f"관리 도구 컨테이너('{name}', {g.protected_role(name)})는 끄거나 지우거나 바꿀 수 없습니다.", "POST", "/containers/a/stop")
    check(f"G {name} 거부 이유", want in r, True)

# Z(11/23): 크기·메모리 바이트 숫자를 읽기 쉬운 글로(9자리 숫자가 docker-agent 기본 가리기에 걸리지 않게)
MASKH = os.path.join(D, "tool_response_transform_secret_mask.py")
def masked(resp, tool="docker_proxy"):
    o = hook(MASKH, {"tool_name": tool, "tool_response": resp})[1]
    return (o.get("hook_specific_output") or {}).get("updated_tool_response", resp)
r = masked(json.dumps([{"RepoTags": ["nginx:latest"], "Size": 183456789}, {"RepoTags": ["redis"], "Size": 39500000}]))
check("Z1 이미지 크기 9자리 → 'MB (쉼표 bytes)'", "183.5MB (183,456,789 bytes)" in r and "183456789" not in r, True)
check("Z2 작은 크기도 같은 형식", "39.5MB (39,500,000 bytes)" in r, True)
r = masked(json.dumps({"memory_stats": {"usage": 268435456, "limit": 4100000000},
                       "cpu_stats": {"cpu_usage": {"total_usage": 123456789}}, "pids_stats": {"limit": 123456789}}))
check("Z3 메모리 사용·상한은 바꿈", "268.4MB (268,435,456 bytes)" in r and "4.1GB" in r, True)
check("Z4 CPU 시간·프로세스 수는 그대로", r.count("123456789") == 2, True)
r = masked(json.dumps({"memoryLimit": 0, "name": "x"}))
check("Z5 0(제한 없음)은 그대로", json.loads(r)["memoryLimit"], 0)
r = masked('{"Size": 183456789, "Env": ["DB_PASSWORD=Secret-123"]}')
check("Z6 크기를 바꾸면서 비밀값 가리기는 그대로", "183.5MB" in r and "Secret-123" not in r and "[REDACTED]" in r, True)
check("Z7 JSON이 아니면 크기는 건드리지 않음", masked("Size 183456789 plain"), "Size 183456789 plain")
check("Z8 StackFileInspect에는 적용하지 않음", "183456789" in masked(json.dumps({"StackFileContent": "x", "Size": 183456789}), "StackFileInspect"), True)

print(f"\n{sum(results)}/{len(results)} 통과")
sys.exit(0 if all(results) else 1)
