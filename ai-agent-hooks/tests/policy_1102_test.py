"""11/2 백업 명령 예외 단독 테스트 (가짜 Portainer 사용, Docker 없이 훅만 실행)
실행: python3 tests/policy_1102_test.py   (ai-agent-hooks 폴더에서)
  - exec는 백업 컨테이너(bosun-backup)의 backup 명령만, 정해진 body로만
  - 2단계(/exec/{id}/start)는 Portainer에 exec 정보를 물어 확인
  - yaml의 exec deny 패턴이 bosun-backup만 비워 두는지(docker-agent 패턴 규칙을 흉내 내 확인)
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fake_portainer  # noqa: E402

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POL = os.path.join(D, "tool_input_transform_direct_policy_guard.py")
EXPL = os.path.join(D, "tool_guard_approval_explainer.py")
YAML = os.path.join(D, "agent.yaml.example")
results = []


def hook(path, payload):
    r = subprocess.run([sys.executable, "-X", "utf8", path], input=json.dumps(payload), capture_output=True, text=True)
    o = json.loads(r.stdout)
    return ("block" if o.get("decision") == "block" else ("rewrite" if o else "pass")), o


def check(name, got, want, extra=True):
    ok = got == want and extra
    results.append(ok)
    print(("OK  " if ok else "XX  ") + name + ("" if ok else f"  (결과 {got}, 기대 {want})"))


def pol(method, path, body=None):
    return hook(POL, {"tool_name": "docker_proxy", "tool_input": {"environment_id": 3, "method": method, "path": path, "body": body}})


def upd(o):
    return o.get("hook_specific_output", {}).get("updated_input", {})


GOOD = {"Cmd": ["backup"], "AttachStdout": True, "AttachStderr": True}
BID = fake_portainer.fake_id("bosun-backup")
WEB = fake_portainer.fake_id("web")

# 1단계: exec 만들기
k, o = pol("POST", "/containers/bosun-backup/exec", GOOD)
check("X1 백업 컨테이너의 backup 명령은 통과(경로는 이름, body는 정해진 것)", (k, upd(o).get("path")), ("rewrite", "/containers/bosun-backup/exec"),
      upd(o).get("body") == GOOD)
k, o = pol("POST", f"/containers/{BID}/exec", {"Cmd": ["backup"]})
check("X2 ID로 와도 이름 경로로 바꾸고 body를 채움", upd(o).get("path"), "/containers/bosun-backup/exec", upd(o).get("body") == GOOD)
k, o = pol("POST", "/containers/web/exec", GOOD)
check("X3 다른 컨테이너의 exec는 거부 + 지금 백업 안내", k, "block", "지금 백업해줘" in o.get("reason", ""))
for title, body in [("sh 명령", {"Cmd": ["sh"]}), ("backup 뒤 인자", {"Cmd": ["backup", "--x"]}), ("문자열 명령", {"Cmd": "backup"}),
                    ("User 지정", {**GOOD, "User": "root"}), ("Privileged", {**GOOD, "Privileged": True}), ("Env 추가", {**GOOD, "Env": ["A=1"]}),
                    ("입력 연결", {**GOOD, "AttachStdin": True}), ("Tty", {**GOOD, "Tty": True})]:
    check(f"X4 {title}은(는) 거부", pol("POST", "/containers/bosun-backup/exec", body)[0], "block")

k, o = pol("POST", "/containers/bosun-backup/exec", None)
check("X5 body가 비어 있으면 정해진 backup 명령으로 채움(실제 실행에서 모델이 null로 보냄)", k, "rewrite", upd(o).get("body") == GOOD)

# 2단계: exec 시작
E_OK, E_WEB, E_SH, E_RUN = ("1" * 64), ("2" * 64), ("3" * 64), ("4" * 64)
fake_portainer.EXECS.update({
    E_OK: {"ContainerID": BID, "Running": False, "ProcessConfig": {"entrypoint": "backup", "arguments": [], "privileged": False, "user": ""}},
    E_WEB: {"ContainerID": WEB, "Running": False, "ProcessConfig": {"entrypoint": "backup", "arguments": []}},
    E_SH: {"ContainerID": BID, "Running": False, "ProcessConfig": {"entrypoint": "sh", "arguments": ["-c", "rm -rf /"]}},
    E_RUN: {"ContainerID": BID, "Running": True, "ProcessConfig": {"entrypoint": "backup", "arguments": []}},
})
k, o = pol("POST", f"/exec/{E_OK}/start", {"Detach": False, "Tty": False})
check("S1 백업 명령 exec 시작은 통과", k, "rewrite", upd(o).get("body") == {"Detach": False, "Tty": False})
check("S2 body 없이 와도 정해진 body로 채움", upd(pol("POST", f"/exec/{E_OK}/start")[1]).get("body"), {"Detach": False, "Tty": False})
check("S3 다른 컨테이너의 exec 번호는 거부", pol("POST", f"/exec/{E_WEB}/start")[0], "block")
check("S4 backup이 아닌 명령의 exec 번호는 거부", pol("POST", f"/exec/{E_SH}/start")[0], "block")
check("S5 이미 실행 중인 exec는 거부", pol("POST", f"/exec/{E_RUN}/start")[0], "block")
check("S6 없는 exec 번호는 거부", pol("POST", f"/exec/{'5' * 64}/start")[0], "block")
check("S7 Detach true는 거부", pol("POST", f"/exec/{E_OK}/start", {"Detach": True})[0], "block")
check("S8 exec 정보 조회(/exec/{id}/json)·resize는 허용 목록 밖", (pol("GET", f"/exec/{E_OK}/json")[0], pol("POST", f"/exec/{E_OK}/resize")[0]),
      ("block", "block"))

# "지금 백업" 실행 훅(tool_response_transform) — 승인된 1단계 뒤에 같은 명령인지 확인하고 바로 실행
RUN = os.path.join(D, "tool_response_transform_backup_runner.py")


def run_hook(path, resp, method="POST"):
    o = hook(RUN, {"tool_name": "docker_proxy", "tool_input": {"environment_id": 3, "method": method, "path": path}, "tool_response": resp})[1]
    return o.get("hook_specific_output", {}).get("updated_tool_response")


R_OK, R_FAIL, R_SH, R_DONE = ("6" * 64), ("7" * 64), ("8" * 64), ("9" * 64)
fake_portainer.EXECS.update({
    R_OK: {"ContainerID": BID, "Running": False, "Pid": 0, "ProcessConfig": {"entrypoint": "backup", "arguments": []},
           "_log": "Finished running backup tasks. password=FakePass-1"},
    R_FAIL: {"ContainerID": BID, "Running": False, "Pid": 0, "ProcessConfig": {"entrypoint": "backup", "arguments": []}, "_exit": 1, "_log": "error"},
    R_SH: {"ContainerID": BID, "Running": False, "Pid": 0, "ProcessConfig": {"entrypoint": "sh", "arguments": []}},
    R_DONE: {"ContainerID": BID, "Running": False, "Pid": 99, "ExitCode": 0, "ProcessConfig": {"entrypoint": "backup", "arguments": []}},
})
t = run_hook("/containers/bosun-backup/exec", f'"{R_OK}"')
check("B1 승인된 백업 준비 뒤 바로 실행하고 결과를 돌려줌", bool(t) and t.startswith("백업을 마쳤습니다"), True, "Finished running backup" in (t or ""))
check("B2 결과에 Docker 로그 머리 글자가 안 남음", "\x00" in (t or ""), False)
check("B3 실패하면 종료 코드와 함께 실패로 알림", (run_hook("/containers/bosun-backup/exec", f'"{R_FAIL}"') or "").startswith("백업이 실패했습니다(종료 코드 1)"), True)
check("B4 backup이 아닌 명령이면 실행하지 않음", "backup 명령이 아닙니다" in (run_hook("/containers/bosun-backup/exec", f'"{R_SH}"') or ""), True,
      fake_portainer.EXECS[R_SH].get("Pid") == 0)  # 시작되지 않음
check("B5 이미 끝난 실행은 다시 하지 않음", "이미 실행 중이거나 끝났습니다" in (run_hook("/containers/bosun-backup/exec", f'"{R_DONE}"') or ""), True)
check("B6 다른 요청 결과는 건드리지 않음", run_hook("/containers/json", "[]", "GET"), None)
check("B7 준비가 거부된 결과(실행 번호 없음)는 거부 이유를 그대로 둠", run_hook("/containers/bosun-backup/exec", "The tool call was rejected … 정책 훅이 이 요청을 거부했습니다."), None)
check("S9 이미 끝난 exec 번호로 2단계를 보내면 거부", pol("POST", f"/exec/{R_DONE}/start")[0], "block")

# 승인 카드 설명
o = hook(EXPL, {"tool_name": "docker_proxy", "tool_input": {"environment_id": 3, "method": "POST", "path": "/containers/bosun-backup/exec", "body": GOOD}})[1]
m = o.get("hook_specific_output", {}).get("metadata", {})
check("C1 승인 카드: 'bosun-backup'으로 지금 백업한다는 설명", m.get("category"), "backup-now", "'bosun-backup' 컨테이너" in m.get("reason", ""))


# yaml의 exec deny 패턴(docker-agent pkg/permissions matchGlob를 흉내: 앵커, *는 / 포함 아무 글자, [^x], 대소문자 무시)
def glob_re(p):
    out, i = r"(?s)\A", 0
    while i < len(p):
        c = p[i]
        if c == "*":
            out += ".*"; i += 1
        elif c == "?":
            out += "."; i += 1
        elif c == "[":
            j = p.index("]", i + 1)
            body = p[i + 1:j]
            neg = body.startswith("^")
            body = body[1:] if neg else body
            cls, k = "", 0
            while k < len(body):
                if body[k] == "\\":
                    cls += "\\" + body[k + 1]; k += 2
                else:
                    cls += "-" if body[k] == "-" else re.escape(body[k]); k += 1
            out += "[" + ("^" if neg else "") + cls + "]"; i = j + 1
        else:
            j = i
            while j < len(p) and p[j] not in "*?[":
                j += 1
            out += re.escape(p[i:j]); i = j
    return re.compile(out + r"\Z")


text = open(YAML, encoding="utf-8").read()
deny = [m.group(1) for m in re.finditer(r"- '?\"?docker_proxy:path=(\*/containers/[^'\"]*exec\*)['\"]?", text)]
denied = lambda path: any(glob_re(p.lower()).match(path.lower()) for p in deny)  # noqa: E731
check("Y0 yaml에 exec deny 패턴이 있음", len(deny) >= 13, True)
for path, want in [("/containers/bosun-backup/exec", False), ("/containers/BOSUN-BACKUP/exec", False), ("/containers/agent-test/exec", True),
                   ("/containers/bosun/exec", True), ("/containers/bosun-backup2/exec", True), ("/containers/" + WEB + "/exec", True),
                   ("/containers/" + BID + "/exec", True), ("/v1.43/containers/web/exec", True)]:
    check(f"Y deny {path[:40]} → {'막음' if want else '통과'}", denied(path), want)

print(f"\n{sum(results)}/{len(results)} 통과")
