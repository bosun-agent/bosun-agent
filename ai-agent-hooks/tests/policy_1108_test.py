"""11/8 변경 단독 테스트 (가짜 Portainer 사용) — 변경 요청에는 select를 쓰지 않음
실행: python3 tests/policy_1108_test.py   (ai-agent-hooks 폴더에서)
왜: mcp-portainer는 요청을 실행한 뒤 응답에 select를 적용한다. select가 잘못되면 작업은 됐는데 오류만 돌아와
    AI가 같은 변경을 다시 보낸다(11/8 웹 테스트: StackStart select "{}" → 실제로는 켜짐 → 재요청 409).
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fake_portainer  # noqa: E402,F401

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STACK = os.path.join(D, "tool_input_transform_stack_guard.py")
POL = os.path.join(D, "tool_input_transform_direct_policy_guard.py")
results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print(("OK  " if ok else "XX  ") + name + ("" if ok else f"  (결과 {got!r:.200}, 기대 {want!r})"))


def hook(path, tool, args):
    r = subprocess.run([sys.executable, "-X", "utf8", path], input=json.dumps({"tool_name": tool, "tool_input": args}),
                       capture_output=True, text=True)
    return json.loads(r.stdout or "{}")


def ui(o):
    return o.get("hook_specific_output", {}).get("updated_input", {})


o = hook(STACK, "StackStart", {"id": 4, "endpointId": 3, "select": "{}"})
check("Z1 StackStart의 잘못된 select는 빼고 보냄", ("select" in ui(o), ui(o).get("select"), o.get("decision")), (True, None, None))
check("Z2 select 없는 StackStart는 그대로 통과", hook(STACK, "StackStop", {"id": 4, "endpointId": 3}), {})
o = hook(STACK, "StackCreateDockerStandaloneString",
         {"endpointId": 3, "Name": "z-1108", "StackFileContent": "services:\n  web:\n    image: nginx:alpine\n", "select": "{id:Id}"})
check("Z3 스택 생성도 select 없이 보냄", ui(o).get("select", "없음"), None)
o = hook(POL, "docker_proxy", {"environment_id": 3, "method": "POST", "path": "/containers/web/stop", "select": "{}"})
check("Z4 docker_proxy 변경(POST)도 select 없이 보냄", ui(o).get("select", "없음"), None)
o = hook(POL, "docker_proxy", {"environment_id": 3, "method": "GET", "path": "/containers/json", "select": "[].{n:Names[0]}"})
check("Z5 조회(GET)의 select는 그대로", ui(o).get("select", "그대로"), "그대로")
o = hook(POL, "docker_proxy", {"environment_id": 3, "method": "DELETE", "path": "/images/x", "select": "{}"})
check("Z6 거부되는 요청은 거부 그대로", o.get("decision"), "block")

print(f"\n{sum(results)}/{len(results)} 통과")
