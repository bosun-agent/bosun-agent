"""11/12 변경 단독 테스트 (가짜 Portainer 사용) — 삭제 옵션 참·거짓 판단을 Docker와 같게
실행: python3 tests/policy_1112_test.py   (ai-agent-hooks 폴더에서)

Docker는 쿼리 값 중 "", 0, no, false, none만 거짓이고 나머지(y, 2, True 등)는 모두 참으로 읽는다.
예전 훅은 1·true·yes·on만 참으로 봐서 force=y, v=2가 검사를 통과했다(웹 담당 11/11 지적).
  - F: 정책 훅 — 컨테이너 삭제의 force·v (11/13: v=true는 정책표 수정본대로 익명 볼륨 백업 확인 후 허용, policy_1113_test)
  - B: 삭제 전 백업 훅 — v
"""
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fake_portainer  # noqa: E402,F401

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POLICY = os.path.join(D, "tool_input_transform_direct_policy_guard.py")
BACKUP = os.path.join(D, "tool_input_transform_direct_backup_guard.py")
DB = os.path.join(tempfile.mkdtemp(), "backups.sqlite3")
results = []


def check(name, got, want, extra=True):
    ok = got == want and extra
    results.append(ok)
    print(("OK  " if ok else "XX  ") + name + ("" if ok else f"  (결과 {got}, 기대 {want})"))


def hook(path, args):
    env = {**os.environ, "AI_AGENT_BACKUP_DB": DB}
    r = subprocess.run([sys.executable, "-X", "utf8", path], input=json.dumps({"tool_name": "docker_proxy", "tool_input": args}),
                       capture_output=True, text=True, env=env)
    o = json.loads(r.stdout or "{}")
    return ("block" if o.get("decision") == "block" else ("rewrite" if o.get("hook_specific_output") else "pass")), o


def delete(path, query=None, guard=POLICY):
    a = {"environment_id": 3, "method": "DELETE", "path": path}
    if query is not None:
        a["query_params"] = query
    return hook(guard, a)


TRUTHY = ["y", "2", "True", "TRUE", "on", "1", "yes", "abc", " 1 ", "-1"]
FALSY = ["0", "false", "False", "no", "none", ""]

# F: 정책 훅
for v in TRUTHY:
    check(f"F1 force={v!r}는 거부", delete("/containers/web", {"force": v})[0], "block")
    k2, o2 = delete("/containers/web", {"v": v})
    check(f"F2 (11/13) v={v!r}는 참으로 보고 v=true로 정리(이름 없는 볼륨이 없으면 통과)", k2 == "rewrite"
          and o2["hook_specific_output"]["updated_input"]["query_params"].get("v") == "true", True)
check("F3 force=True(값이 불리언)도 거부", delete("/containers/web", {"force": True})[0], "block")
check("F4 (11/13) v=2(숫자)도 참 → v=true", delete("/containers/web", {"v": 2})[1].get("hook_specific_output", {}).get("updated_input", {}).get("query_params", {}).get("v"), "true")
check("F5 query_params가 JSON 글자여도 거부", delete("/containers/web", '{"force": "y"}')[0], "block")
for v in FALSY:
    k, o = delete("/containers/web", {"force": v, "v": v})
    q = o.get("hook_specific_output", {}).get("updated_input", {}).get("query_params")
    check(f"F6 force·v={v!r}(거짓)는 통과하고 두 값은 빼고 보냄", k == "rewrite" and isinstance(q, dict)
          and "force" not in q and "v" not in q, True)
k, o = delete("/containers/web")
check("F7 옵션 없는 삭제는 그대로 통과", k, "rewrite")
check("F8 다른 경로의 v(예: 이미지 삭제)는 원래대로 거부", delete("/images/nginx", {"force": "0"})[0], "block")

# B: 삭제 전 백업 훅
for v in ["y", "2", "True", "abc"]:
    check(f"B1 (11/13) 백업 훅은 v={v!r}를 막지 않음(정책 훅이 익명 볼륨 백업 확인)", delete("/containers/web", {"v": v}, BACKUP)[0] != "block", True)
for v in ["0", "no", "none", "false"]:
    check(f"B2 백업 훅 v={v!r}(거짓)는 막지 않음", delete("/containers/web", {"v": v}, BACKUP)[0] != "block", True)

print(f"\n{sum(results)}/{len(results)} 통과")
