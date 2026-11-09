"""11/6 변경 단독 테스트 (가짜 Portainer 사용) — 보안 정책표대로 맞춤
실행: python3 tests/policy_1106_test.py   (ai-agent-hooks 폴더에서)
  - U: 스택 수정(StackUpdate, 정책표 5.7 ASK) 인자·대상·Compose 검사, 가려진 값 되살리기
  - F: 스택 파일 보기(StackFileInspect) 인자 검사, 결과의 비밀값 가리기
  - C: 같은 이름 스택 생성 거부(정책표 5.7 이름 충돌 DENY)
  - T: 스택 켜기·끄기 대상 확인, 관리 스택 보호
  - Q: 시스템 정보·네트워크·이미지 이력은 안전한 필드만(정책표 3절)
  - E: 승인 카드 설명(수정 전후 바뀐 줄, 비밀값 가림)
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fake_portainer  # noqa: E402

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STACK = os.path.join(D, "tool_input_transform_stack_guard.py")
POL = os.path.join(D, "tool_input_transform_direct_policy_guard.py")
EXPL = os.path.join(D, "tool_guard_approval_explainer.py")
MASK_HOOK = os.path.join(D, "tool_response_transform_secret_mask.py")
results = []


def check(name, got, want, extra=True):
    ok = got == want and extra
    results.append(ok)
    print(("OK  " if ok else "XX  ") + name + ("" if ok else f"  (결과 {got}, 기대 {want})"))


def hook(path, payload):
    r = subprocess.run([sys.executable, "-X", "utf8", path], input=json.dumps(payload), capture_output=True, text=True)
    o = json.loads(r.stdout or "{}")
    return ("block" if o.get("decision") == "block" else ("rewrite" if o.get("hook_specific_output") else "pass")), o


def stack(tool, args):
    return hook(STACK, {"tool_name": tool, "tool_input": args})


def updated(o):
    return o.get("hook_specific_output", {}).get("updated_input", {})


NEW = ("services:\n  web:\n    image: nginx:alpine\n    ports:\n      - \"8088:80\"\n  db:\n    image: mysql:8\n"
       "    environment:\n      MYSQL_RANDOM_ROOT_PASSWORD: \"yes\"\n      MYSQL_DATABASE: app\n")
# 11/9: 비밀번호를 적은 옛 스택(가짜 Portainer 스택 4)을 [REDACTED] 그대로 되돌려 보내는 경우
OLDPW = NEW.replace("MYSQL_RANDOM_ROOT_PASSWORD: \"yes\"", "MYSQL_ROOT_PASSWORD: [REDACTED]")

# U: 스택 수정
k, o = stack("StackUpdate", {"id": 4, "endpointId": 3, "StackFileContent": NEW})
up = updated(o).get("StackFileContent", "")
check("U1 정상 수정은 통과하고 검사한 Compose로 다시 씀", k, "rewrite", "8088:80" in up and "mem_limit" in up)
k2, o2 = stack("StackUpdate", {"id": 4, "endpointId": 3, "StackFileContent": OLDPW})
check("U2 (11/9) [REDACTED] 비밀번호를 되살리면 평문이 되므로 거부", k2, "block",
      "평문 비밀번호" in o2.get("reason", "") and "Old-Secret-1106" not in o2.get("reason", ""))
k, o = stack("StackUpdate", {"id": 4, "endpointId": 3,
                             "StackFileContent": NEW.replace("MYSQL_DATABASE: app", "MYSQL_PASSWORD: [REDACTED]")})
check("U3 원래 없던 키의 [REDACTED]는 거부", k, "block", "되살릴 수 없습니다" in o.get("reason", ""))
k, o = stack("StackUpdate", {"id": 4, "endpointId": 3, "StackFileContent": NEW.replace("image: nginx:alpine", "image: nginx:alpine\n    command: [\"[REDACTED]\"]")})
check("U4 environment 밖의 [REDACTED]는 거부", k, "block")
for opt, val in (("Prune", False), ("PullImage", False), ("RepullImageAndRedeploy", True), ("RollbackTo", 1), ("Webhook", "x")):
    check(f"U5 {opt} 옵션은 값과 상관없이 거부({val})",
          stack("StackUpdate", {"id": 4, "endpointId": 3, "StackFileContent": NEW, opt: val})[0], "block")
check("U6 Registries 지정 거부", stack("StackUpdate", {"id": 4, "endpointId": 3, "StackFileContent": NEW, "Registries": [1]})[0], "block")
k, o = stack("StackUpdate", {"id": 4, "endpointId": 3})
check("U7 Compose 없는 수정 거부 + StackFileInspect 안내", k, "block", "StackFileInspect" in o.get("reason", ""))
check("U8 환경이 다르면 거부", stack("StackUpdate", {"id": 4, "endpointId": 2, "StackFileContent": NEW})[0], "block")
k, o = stack("StackUpdate", {"id": 99, "endpointId": 3, "StackFileContent": NEW})
check("U9 없는 스택 거부 + 목록 확인 안내", k, "block", "StackList" in o.get("reason", ""))
k, o = stack("StackUpdate", {"id": 5, "endpointId": 3, "StackFileContent": "services:\n  b:\n    image: nginx\n"})
check("U10 관리 스택(bosun-backup) 수정 거부", k, "block", "관리용 스택" in o.get("reason", ""))
check("U11 Compose 스택이 아니면 거부", stack("StackUpdate", {"id": 6, "endpointId": 3, "StackFileContent": NEW})[0], "block")
check("U12 수정에도 생성과 같은 검사(privileged 거부)",
      stack("StackUpdate", {"id": 4, "endpointId": 3, "StackFileContent": "services:\n  w:\n    image: nginx\n    privileged: true\n"})[0], "block")
check("U13 수정에도 공식 이미지 규칙", stack("StackUpdate", {"id": 4, "endpointId": 3,
                                                   "StackFileContent": "services:\n  w:\n    image: bitnami/redis\n"})[0], "block")
check("U14 Env 값이 [REDACTED]면 거부", stack("StackUpdate", {"id": 4, "endpointId": 3, "StackFileContent": NEW,
                                                     "Env": [{"name": "A", "value": "[REDACTED]"}]})[0], "block")

# F: 스택 파일 보기
check("F1 StackFileInspect id만이면 통과", stack("StackFileInspect", {"id": 4})[0], "pass")
check("F2 commitHash는 거부", stack("StackFileInspect", {"id": 4, "commitHash": "abc"})[0], "block")
k, o = stack("StackFileInspect", {"id": 4, "commitHash": None, "version": None, "select": None})
check("F2b null로 채운 선택 인자는 빼고 통과(실제 모델 동작)", k, "rewrite", updated(o) == {"id": 4})
k, o = stack("StackUpdate", {"id": 4, "endpointId": 3, "StackFileContent": NEW, "Prune": None, "Webhook": None, "Registries": None})
check("U15 수정의 null 옵션은 보내지 않은 것으로 보고 통과", k, "rewrite", "Prune" not in updated(o))
check("F3 id 문자열 거부", stack("StackFileInspect", {"id": "4"})[0], "block")
resp = json.dumps({"StackFileContent": fake_portainer.STACKS[4]["_file"]})
o = hook(MASK_HOOK, {"tool_name": "StackFileInspect", "tool_response": resp})[1]
masked = o.get("hook_specific_output", {}).get("updated_tool_response", "")
body = json.loads(masked.split("\n\n[비밀값")[0])["StackFileContent"] if masked else ""
check("F4 결과의 비밀번호는 가리고 줄바꿈·다른 줄은 그대로",
      "Old-Secret-1106" not in masked and "MYSQL_ROOT_PASSWORD: [REDACTED]\n      MYSQL_DATABASE: app" in body, True)
k5, o5 = stack("StackUpdate", {"id": 4, "endpointId": 3, "StackFileContent": body})
check("F5 (11/9) 가린 결과를 그대로 돌려보내도 평문 비밀번호라 거부, 안내에 원래 값 없음",
      k5 == "block" and "Old-Secret-1106" not in json.dumps(o5, ensure_ascii=False), True)

# C: 같은 이름
SIMPLE = "services:\n  web:\n    image: nginx:alpine\n"


def create(name, content=SIMPLE):
    return stack("StackCreateDockerStandaloneString", {"endpointId": 3, "Name": name, "StackFileContent": content})


check("C1 새 이름은 통과", create("newapp")[0], "rewrite")
k, o = create("myweb")
check("C2 같은 이름의 스택 거부 + 수정 안내", k, "block", "StackUpdate" in o.get("reason", ""))
fake_portainer.STACKS[7] = {"Id": 7, "Name": "OldApp", "EndpointId": 3, "Type": 2, "_file": SIMPLE}
check("C3 기존 스택과 대소문자만 달라도 거부(OldApp ↔ oldapp)", create("oldapp")[0], "block")
del fake_portainer.STACKS[7]
check("C4 Portainer 밖의 같은 Compose 프로젝트 거부", create("outside-app")[0], "block")
check("C5 container_name이 기존 컨테이너와 같으면 거부", create("app2", SIMPLE + "    container_name: web-old\n")[0], "block")
check("C6 container_name을 두 번 쓰면 거부",
      create("app3", "services:\n  a:\n    image: nginx\n    container_name: x1\n  b:\n    image: nginx\n    container_name: x1\n")[0], "block")
saved = os.environ.pop("PORTAINER_URL")
check("C7 Portainer 조회 실패면 거부(fail-closed)", create("newapp")[0], "block")
os.environ["PORTAINER_URL"] = saved

# T: 켜기·끄기
check("T1 StackStart 통과", stack("StackStart", {"id": 4, "endpointId": 3})[0], "pass")
check("T2 없는 스택 끄기 거부", stack("StackStop", {"id": 99, "endpointId": 3})[0], "block")
check("T3 관리 스택 끄기 거부", stack("StackStop", {"id": 5, "endpointId": 3})[0], "block")
check("T4 관리 스택 켜기는 통과", stack("StackStart", {"id": 5, "endpointId": 3})[0], "pass")
check("T5 StackDelete는 여전히 거부", stack("StackDelete", {"id": 4, "endpointId": 3})[0], "block")


# Q: 안전한 필드
def sel(path):
    o = hook(POL, {"tool_name": "docker_proxy", "tool_input": {"environment_id": 3, "method": "GET", "path": path, "select": "@"}})[1]
    return updated(o).get("select", "")


check("Q1 /info는 호스트명(Name)·레지스트리 설정 없이", "serverVersion" in sel("/info") and "Name" not in sel("/info").replace("OperatingSystem", ""), True)
check("Q2 네트워크 목록은 IPAM(내부 IP) 없이", "IPAM" not in sel("/networks") and "name:Name" in sel("/networks"), True)
check("Q3 네트워크 상세는 컨테이너 이름만", "Containers.*.Name" in sel("/networks/app-net") and "IPv4" not in sel("/networks/app-net"), True)
check("Q4 이미지 이력은 CreatedBy 없이", "CreatedBy" not in sel("/images/nginx/history") and "created:Created" in sel("/images/nginx/history"), True)
check("Q5 컨테이너 목록은 모델 select 그대로", sel("/containers/json"), "")


# E: 승인 카드 설명
def meta(tool, args):
    return hook(EXPL, {"tool_name": tool, "tool_input": args})[1].get("hook_specific_output", {}).get("metadata", {})


up_args = updated(stack("StackUpdate", {"id": 4, "endpointId": 3, "StackFileContent": NEW})[1])
m = meta("StackUpdate", up_args)
check("E1 수정 카드: 스택 이름과 바뀐 줄(포트 추가) 표시", "'myweb' 스택" in m.get("reason", "") and "8088" in m.get("reason", ""), True)
check("E2 수정 카드에 비밀번호 원문 없음", "Old-Secret-1106" not in m.get("reason", ""), True)
check("E3 수정 영향은 high", m.get("blast_radius"), "high")
check("E4 파일 보기 카드는 low", meta("StackFileInspect", {"id": 4}).get("blast_radius"), "low")

print(f"\n{sum(results)}/{len(results)} 통과")
