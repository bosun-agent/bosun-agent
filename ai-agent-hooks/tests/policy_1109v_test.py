"""11/9 데이터 볼륨 규칙 테스트 (가짜 Portainer 사용)
실행: python3 tests/policy_1109v_test.py   (ai-agent-hooks 폴더에서)
  - N: 데이터 저장 이미지(redis·mysql·mariadb·postgres·mongo)는 데이터 위치에 이름 있는 볼륨 필수
  - A: 지금 이름 없는(익명) 볼륨을 쓰는 스택은 수정 거부(다시 배포하면 새 빈 볼륨으로 바뀜, 11/9 결합 시험에서 확인)
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fake_portainer  # noqa: E402

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STACK = os.path.join(D, "tool_input_transform_stack_guard.py")
results = []


def check(name, got, want, extra=True):
    ok = got == want and extra
    results.append(ok)
    print(("OK  " if ok else "XX  ") + name + ("" if ok else f"  (결과 {got}, 기대 {want})"))


def hook(tool, args):
    r = subprocess.run([sys.executable, "-X", "utf8", STACK], input=json.dumps({"tool_name": tool, "tool_input": args}),
                       capture_output=True, text=True)
    o = json.loads(r.stdout or "{}")
    return ("block" if o.get("decision") == "block" else ("rewrite" if o.get("hook_specific_output") else "pass")), o


def create(compose, name="volapp"):
    return hook("StackCreateDockerStandaloneString", {"endpointId": 3, "Name": name, "StackFileContent": compose})


def one(image, vols=None, env=""):
    v = f"    volumes: {json.dumps(vols)}\nvolumes:\n  d: {{}}\n" if vols else ""
    return f"services:\n  s:\n    image: {image}\n{env}{v}"


PW = '    environment:\n      MYSQL_RANDOM_ROOT_PASSWORD: "yes"\n'
# N
for label, img, env in [("redis", "redis:7-alpine", ""), ("redis 전체 이름", "docker.io/library/redis:7", ""),
                        ("mysql", "mysql:8.0", PW), ("mariadb", "mariadb:11", PW.replace("MYSQL", "MARIADB")),
                        ("postgres", "postgres:16", ""), ("mongo", "mongo:7", "")]:
    k, o = create(one(img, env=env))
    check(f"N1 {label}에 데이터 볼륨이 없으면 거부", k, "block", "이름 있는 볼륨" in o.get("reason", ""))
for label, img, path, env in [("redis", "redis:7-alpine", "/data", ""), ("mysql", "mysql:8.0", "/var/lib/mysql", PW),
                              ("mariadb", "mariadb:11", "/var/lib/mysql", PW.replace("MYSQL", "MARIADB")), ("mongo", "mongo:7", "/data/db", "")]:
    check(f"N2 {label}에 '{path}' 이름 있는 볼륨이면 통과", create(one(img, [f"d:{path}"], env))[0], "rewrite")
check("N3 다른 위치에만 볼륨이 있으면 거부(redis /cache)", create(one("redis:7", ["d:/cache"]))[0], "block")
check("N4 긴 형식(type: volume, target)도 인정", create("services:\n  s:\n    image: redis:7\n    volumes:\n      - type: volume\n"
                                                  "        source: d\n        target: /data\nvolumes:\n  d: {}\n")[0], "rewrite")
check("N5 끝에 / 붙은 위치도 인정(/data/)", create(one("redis:7", ["d:/data/"]))[0], "rewrite")
check("N6 데이터 이미지가 아니면 볼륨 없어도 통과(nginx)", create(one("nginx:alpine"))[0], "rewrite")
k, o = create(one("redis:7"))
check("N7 거부 안내에 예시(data:/data)와 이유", "data:/data" in o["reason"] and "③" in o["reason"], True)

# A
fake_portainer.STACKS[21] = {"Id": 21, "Name": "anonapp", "EndpointId": 3, "Type": 2, "_file": "services:\n  r:\n    image: redis:7\n"}
fake_portainer.STACK_MOUNTS["anonapp"] = ["a" * 64]
fake_portainer.STACKS[22] = {"Id": 22, "Name": "namedapp", "EndpointId": 3, "Type": 2, "_file": "services:\n  r:\n    image: redis:7\n"}
fake_portainer.STACK_MOUNTS["namedapp"] = ["namedapp_d"]
GOOD = one("redis:7", ["d:/data"])
k, o = hook("StackUpdate", {"id": 21, "endpointId": 3, "StackFileContent": GOOD})
check("A1 지금 이름 없는 볼륨을 쓰면 수정 거부(새 Compose에 볼륨을 넣어도)", k, "block", "이름 없는 볼륨" in o.get("reason", ""))
check("A2 거부 안내에 관리자 안내", "관리자" in o.get("reason", ""), True)
check("A3 이름 있는 볼륨을 쓰는 스택은 수정 통과", hook("StackUpdate", {"id": 22, "endpointId": 3, "StackFileContent": GOOD})[0], "rewrite")
check("A4 켜기·끄기는 이름 없는 볼륨이어도 그대로 가능", hook("StackStop", {"id": 21, "endpointId": 3})[0], "pass")
saved = os.environ.pop("PORTAINER_URL")
check("A5 컨테이너 조회 실패면 수정 거부(fail-closed)", hook("StackUpdate", {"id": 22, "endpointId": 3, "StackFileContent": GOOD})[0], "block")
os.environ["PORTAINER_URL"] = saved

print(f"\n{sum(results)}/{len(results)} 통과")
