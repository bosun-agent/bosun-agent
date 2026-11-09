"""11/9 변경 단독 테스트 (가짜 Portainer 사용) — 비밀번호를 정책표대로(5.7·215·238줄)
실행: python3 tests/policy_1109_test.py   (ai-agent-hooks 폴더에서)
  - P: Compose environment에 비밀번호·토큰 값을 적으면 거부, 주소 안 user:비밀번호@ 거부
  - V: Env 인자에도 비밀값 거부
  - R: 앱이 스스로 만드는 비밀번호 설정(MYSQL_RANDOM_ROOT_PASSWORD 등)은 허용, 그 로그는 가림
  - G: 거부 안내 ①②③
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fake_portainer  # noqa: E402,F401  (PORTAINER_URL 등 준비)

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STACK = os.path.join(D, "tool_input_transform_stack_guard.py")
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


def create(compose, name="pwtest", **extra):
    return hook(STACK, {"tool_name": "StackCreateDockerStandaloneString",
                        "tool_input": {"endpointId": 3, "Name": name, "StackFileContent": compose, **extra}})


def db(env_block, image="mysql:8"):
    return f"services:\n  db:\n    image: {image}\n    environment:\n{env_block}"


# P: Compose 안 평문 비밀번호
for label, env in [
    ("MYSQL_ROOT_PASSWORD 값", '      MYSQL_ROOT_PASSWORD: abc123\n'),
    ("목록 형식 KEY=값", '      - MYSQL_PASSWORD=abc123\n'),
    ("POSTGRES_PASSWORD", '      POSTGRES_PASSWORD: example\n'),
    ("소문자 db_password", '      db_password: x1\n'),
    ("API_KEY", '      API_KEY: k-123\n'),
    ("SECRET_KEY_BASE", '      SECRET_KEY_BASE: s\n'),
    ("ACCESS_TOKEN", '      ACCESS_TOKEN: t\n'),
    ("주소 안 user:비밀번호@", '      DATABASE_URL: postgres://app:s3cret@db:5432/app\n'),
    ("MYSQL_ALLOW_EMPTY_PASSWORD(빈 비밀번호 허용)", '      MYSQL_ALLOW_EMPTY_PASSWORD: "yes"\n'),
    ("POSTGRES_HOST_AUTH_METHOD trust", '      POSTGRES_HOST_AUTH_METHOD: trust\n'),
    ("RANDOM 설정에 yes 외 값", '      MYSQL_RANDOM_ROOT_PASSWORD: abc123\n'),
]:
    k, o = create(db(env))
    check(f"P {label} 거부", k, "block", "abc123" not in o.get("reason", "") and "s3cret" not in o.get("reason", ""))

# 비밀번호가 아닌 것은 그대로
check("P 비밀번호 아닌 값(MYSQL_DATABASE) 통과", create(db('      MYSQL_DATABASE: app\n      MYSQL_USER: app\n'))[0], "rewrite")
check("P 주소에 비밀번호 없으면 통과", create(db('      REDIS_URL: redis://cache:6379/0\n'))[0], "rewrite")
check("P 값 없이 키만(목록 형식) 통과", create(db('      - MYSQL_PASSWORD\n'))[0], "rewrite")
check("P 빈 값 통과", create(db('      MYSQL_PASSWORD: ""\n      MYSQL_DATABASE: app\n'))[0], "rewrite")

# V: Env 인자
SIMPLE = "services:\n  web:\n    image: nginx:alpine\n"
check("V Env에 비밀번호 이름+값 거부", create(SIMPLE, Env=[{"name": "DB_PASSWORD", "value": "abc"}])[0], "block")
check("V Env 값 안 user:비밀번호@ 거부", create(SIMPLE, Env=[{"name": "DSN", "value": "mysql://u:p@db/x"}])[0], "block")
check("V Env 일반 값 통과", create(SIMPLE, Env=[{"name": "MODE", "value": "prod"}])[0], "rewrite")
check("V 수정(StackUpdate)도 같은 검사",
      hook(STACK, {"tool_name": "StackUpdate", "tool_input": {"id": 4, "endpointId": 3,
           "StackFileContent": db('      MYSQL_ROOT_PASSWORD: newpw\n')}})[0], "block")

# R: 앱이 스스로 만드는 비밀번호
for label, env in [("MYSQL_RANDOM_ROOT_PASSWORD yes", '      MYSQL_RANDOM_ROOT_PASSWORD: "yes"\n'),
                   ("MARIADB_RANDOM_ROOT_PASSWORD true", '      MARIADB_RANDOM_ROOT_PASSWORD: "true"\n'),
                   ("목록 형식 =1", '      - MYSQL_RANDOM_ROOT_PASSWORD=1\n')]:
    check(f"R {label} 통과", create(db(env, "mariadb:11" if "MARIADB" in label else "mysql:8"))[0], "rewrite")
for line in ("2026-11-09 [Entrypoint] GENERATED ROOT PASSWORD: Zq8+uV3kLm0pW2x\n",
             "[Note] [Entrypoint] GENERATED ROOT PASSWORD: Zq8+uV3kLm0pW2x\n"):
    o = hook(MASK_HOOK, {"tool_name": "docker_proxy", "tool_response": line})[1]
    check("R 만들어진 비밀번호 로그 줄은 가림", "Zq8+uV3kLm0pW2x" in json.dumps(o), False)

# G: 거부 안내
k, o = create(db('      MYSQL_ROOT_PASSWORD: abc123\n'))
r = o.get("reason", "")
check("G 안내에 이유와 대신 할 것(RANDOM_ROOT_PASSWORD) 포함", "①" in r and "③" in r and "MYSQL_RANDOM_ROOT_PASSWORD" in r, True)
k, o = create(db('      POSTGRES_HOST_AUTH_METHOD: trust\n', "postgres:16"))
check("G trust 안내도 비밀번호 규칙으로", "관리자" in o.get("reason", ""), True)

print(f"\n{sum(results)}/{len(results)} 통과")
