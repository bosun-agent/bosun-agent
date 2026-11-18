"""11/15 사용자 정책(웹 정책 보드) 훅 + 안내문 변경 테스트
실행: python3 tests/policy_1115_test.py   (ai-agent-hooks 폴더에서)
"""
import json
import os
import subprocess
import sys
import tempfile

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(D, "tool_guard_user_policy.py")
results = []
TMP = tempfile.mkdtemp(prefix="userpolicy-")


def check(name, got, want, extra=True):
    ok = got == want and extra
    results.append(ok)
    print(("OK  " if ok else "XX  ") + name + ("" if ok else f"  (결과 {got!r:.200}, 기대 {want!r})"))


def policy(content, name="p.json"):
    path = os.path.join(TMP, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content if isinstance(content, str) else json.dumps(content))
    return path


def run(tool, args=None, path=None, env_set=True):
    env = dict(os.environ)
    env.pop("BOSUN_USER_POLICY", None)
    if env_set:
        env["BOSUN_USER_POLICY"] = path or ""
    r = subprocess.run([sys.executable, "-X", "utf8", HOOK], input=json.dumps({"tool_name": tool, "tool_input": args or {}}),
                       capture_output=True, text=True, env=env)
    o = json.loads(r.stdout or "{}")
    return o.get("hook_specific_output", {}).get("permission_decision"), r.returncode


P = policy({"version": 1, "tools": {
    "StackDelete": "deny",
    "backup_volume": "ask",
    "backup_status": "allow",
    "docker_proxy:method=GET:path=/containers/*/logs": "ask",
    "docker_proxy:method=DELETE:path=/volumes/*": "deny",
    "docker_proxy:method=POST:path=/containers/*/exec": "allow",
}})

# 1) 규칙대로
check("U1 deny 도구는 막음", run("StackDelete", {"id": 3}, P)[0], "deny")
check("U2 ask 도구는 승인 카드", run("backup_volume", {"volume": "x"}, P)[0], "ask")
check("U3 allow는 아무것도 하지 않음(더 풀지 않음)", run("backup_status", {"job_id": "x"}, P)[0], None)
check("U4 docker_proxy 패턴 ask(로그)", run("docker_proxy", {"method": "GET", "path": "/containers/web/logs"}, P)[0], "ask")
check("U5 docker_proxy 패턴 deny(볼륨 삭제)", run("docker_proxy", {"method": "DELETE", "path": "/volumes/data"}, P)[0], "deny")
check("U6 버전 접두어(/v1.43)도 같은 규칙", run("docker_proxy", {"method": "DELETE", "path": "/v1.43/volumes/data"}, P)[0], "deny")
check("U7 method 생략은 GET으로 봄", run("docker_proxy", {"path": "/containers/web/logs"}, P)[0], "ask")
check("U8 규칙에 없는 작업은 지금 동작", run("docker_proxy", {"method": "GET", "path": "/containers/json"}, P)[0], None)
# 2) 정책표가 막은 것을 allow로 풀 수 없음: 이 훅은 allow에 아무 판정도 내지 않는다(exec 거부는 정책 훅·deny가 그대로)
check("U9 정책표 금지(exec)를 allow로 옮겨도 이 훅은 허용 판정을 내지 않음",
      run("docker_proxy", {"method": "POST", "path": "/containers/web/exec"}, P)[0], None)
# 3) 여러 규칙이 맞으면 가장 엄격한 것
P2 = policy({"tools": {"docker_proxy:method=DELETE:path=*": "ask", "docker_proxy:method=DELETE:path=/networks/*": "deny"}}, "p2.json")
check("U10 겹치면 deny가 이김", run("docker_proxy", {"method": "DELETE", "path": "/networks/n1"}, P2)[0], "deny")
check("U11 *는 / 를 넘어 맞춤(더 엄격)", run("docker_proxy", {"method": "DELETE", "path": "/containers/web"}, P2)[0], "ask")
# 4) 파일 없음·깨짐·이상한 값이면 지금 동작
check("U12 환경변수 없음", run("StackDelete", env_set=False)[0], None)
check("U13 파일 없음", run("StackDelete", path=os.path.join(TMP, "nope.json"))[0], None)
check("U14 JSON 깨짐", run("StackDelete", path=policy("{not json", "bad.json"))[0], None)
check("U15 tools 없음", run("StackDelete", path=policy({"version": 1}, "norules.json"))[0], None)
check("U16 이상한 값(block)은 무시", run("StackDelete", path=policy({"tools": {"StackDelete": "block"}}, "odd.json"))[0], None)
check("U17 최상위가 목록이어도 무시", run("StackDelete", path=policy("[1,2]", "list.json"))[0], None)
check("U19 예전 이름 rules도 같은 뜻", run("StackDelete", path=policy({"rules": {"StackDelete": "deny"}}, "old.json"))[0], "deny")
check("U18 깨진 입력에도 오류 없이 {}", run("StackDelete", {"id": 1}, policy("", "empty.json"))[1], 0)

# 5) 설정·안내문
for name in ("agent.yaml.example", "../agents/beginner.yaml.example", "../agents/expert.yaml.example"):
    text = open(os.path.join(D, name), encoding="utf-8").read()
    head = text.split("[할 수 있는 일]", 1)[1].split("[도구 사용]", 1)[0]
    # 11/17: 정책 보드 "자유롭게 조정" — 사용자 정책 훅은 등록 해제(웹이 permissions를 직접 고친다)
    check(f"I1 {os.path.basename(name)}: 사용자 정책 훅 등록 해제", "tool_guard_user_policy.py" not in text.replace("# 11/17 사용자 정책 훅(tool_guard_user_policy.py)", "") and "BOSUN_USER_POLICY" not in text, True)
    check(f"I2 {os.path.basename(name)}: [할 수 있는 일]에 '바로 실행된다/승인을 받아 실행된다' 목록 없음",
          "바로 실행된다" not in head and "승인을 받아 실행된다" not in head, True)
    check(f"I3 {os.path.basename(name)}: 막히면 이유를 알리고 우회하지 않는다", "막힌 이유를 알리고" in head and "우회하지 않는다" in head, True)

print(f"\n{sum(results)}/{len(results)} 통과")
