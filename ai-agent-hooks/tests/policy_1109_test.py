"""11/9 변경 단독 테스트 (가짜 Portainer 사용) — 비밀번호를 정책표대로(5.7·215·238줄)
실행: python3 tests/policy_1109_test.py   (ai-agent-hooks 폴더에서)
  - P: Compose environment에 비밀번호·토큰 값을 적으면 거부, 주소 안 user:비밀번호@ 거부
  - V: Env 인자에도 비밀값 거부
  - R: 앱이 스스로 만드는 비밀번호 설정(MYSQL_RANDOM_ROOT_PASSWORD 등)은 허용, 그 로그는 가림
  - G: 거부 안내 ①②③
  - E·C·H: entrypoint 거부, command·healthcheck는 허용 목록만(정책표 5.7 231줄)
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

# E·C·H: entrypoint·command·healthcheck (정책표 5.7 231줄)
def svc(image, extra):
    return f"services:\n  a:\n    image: {image}\n{extra}"


for label, image, extra in [
    ("entrypoint 문자열", "redis:7", '    entrypoint: sh\n'),
    ("entrypoint 목록", "nginx:alpine", '    entrypoint: ["/bin/sh", "-c", "id"]\n'),
    ("entrypoint 빈 목록(기본 시작 프로그램 지우기)", "redis:7", '    entrypoint: []\n'),
    ("command sh -c", "redis:7", '    command: sh -c "redis-server"\n'),
    ("command 목록 [sh, -c]", "redis:7", '    command: ["sh", "-c", "id"]\n'),
    ("command python -c", "python:3.12", '    command: python -c "print(1)"\n'),
    ("목록 없는 이미지(nginx)에 command", "nginx:alpine", '    command: nginx -g "daemon off;"\n'),
    ("redis 모르는 옵션", "redis:7", '    command: redis-server --loadmodule /x.so\n'),
    ("redis 값 형식 틀림", "redis:7", '    command: redis-server --appendonly maybe\n'),
    ("redis 옵션 뒤에 셸 이어 붙이기", "redis:7", '    command: redis-server --appendonly yes ; sh\n'),
    ("redis 값 개수 모자람(--save 60)", "redis:7", '    command: redis-server --save 60\n'),
    ("mysql 다른 프로그램", "mysql:8", '    command: mysql -e "drop database x"\n'),
    ("mysql --init-file", "mysql:8", '    command: --init-file=/tmp/x.sql\n'),
    ("따옴표 안 맞음", "redis:7", '    command: redis-server "--appendonly yes\n'),
    ("healthcheck CMD-SHELL", "redis:7", '    healthcheck:\n      test: ["CMD-SHELL", "redis-cli ping || exit 1"]\n'),
    ("healthcheck 문자열(셸)", "redis:7", '    healthcheck:\n      test: redis-cli ping\n'),
    ("healthcheck 목록 밖 CMD", "nginx:alpine", '    healthcheck:\n      test: ["CMD", "curl", "-f", "http://localhost"]\n'),
]:
    k, o = create(svc(image, extra))
    check(f"E/C/H {label} 거부", k, "block")

for label, image, extra in [
    ("command 없음", "redis:7", ''),
    ("redis --appendonly yes", "redis:7", '    command: redis-server --appendonly yes\n'),
    ("redis 목록 형식 + 여러 옵션", "redis:7", '    command: ["redis-server", "--appendonly", "yes", "--save", "60", "1", "--maxmemory", "256mb"]\n'),
    ("redis 프로그램 이름 없이 옵션만", "redis:7-alpine", '    command: --appendonly yes\n'),
    ("redis --maxmemory-policy", "redis", '    command: redis-server --maxmemory-policy allkeys-lru\n'),
    ("mysql 문자 설정 = 형식", "mysql:8.0", '    command: --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci\n'),
    ("mysql 밑줄 이름(--max_connections)", "mysql:8", '    command: mysqld --max_connections=50\n'),
    ("mariadb mariadbd", "mariadb:11", '    command: mariadbd --character-set-server=utf8mb4\n'),
    ("healthcheck redis-cli ping", "redis:7", '    healthcheck:\n      test: ["CMD", "redis-cli", "ping"]\n      interval: 10s\n'),
    ("healthcheck mysqladmin ping", "mysql:8", '    healthcheck:\n      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]\n'),
    ("healthcheck NONE(끄기)", "nginx:alpine", '    healthcheck:\n      test: ["NONE"]\n'),
]:
    env = '    environment:\n      MYSQL_RANDOM_ROOT_PASSWORD: "yes"\n' if image.startswith("mysql") else ''
    env = '    environment:\n      MARIADB_RANDOM_ROOT_PASSWORD: "yes"\n' if image.startswith("mariadb") else env
    check(f"E/C/H {label} 통과", create(svc(image, env + extra))[0], "rewrite")

k, o = create(svc("redis:7", '    command: sh -c "id"\n'))
r = o.get("reason", "")
check("G command 거부 안내에 허용 옵션 예시", "③" in r and "--appendonly yes" in r, True)
k, o = create(svc("redis:7", '    entrypoint: sh\n'))
check("G entrypoint 거부 안내", "entrypoint" in o.get("reason", "") and "③" in o.get("reason", ""), True)
k, o = hook(STACK, {"tool_name": "StackUpdate", "tool_input": {"id": 4, "endpointId": 3,
             "StackFileContent": svc("redis:7", '    entrypoint: sh\n')}})
check("E 수정(StackUpdate)도 entrypoint 거부", k, "block")

print(f"\n{sum(results)}/{len(results)} 통과")
