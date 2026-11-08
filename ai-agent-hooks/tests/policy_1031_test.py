"""10/31 정책 변경 단독 테스트 (Portainer·Docker 없이 훅만 실행)
실행: python3 tests/policy_1031_test.py   (ai-agent-hooks 폴더에서)
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fake_portainer  # noqa: E402,F401 — 11/1: 정책 훅이 컨테이너를 Portainer에 물어 ID로 고정하므로 가짜 Portainer를 띄운다

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POLICY = os.path.join(D, "tool_input_transform_direct_policy_guard.py")
STACK = os.path.join(D, "tool_input_transform_stack_guard.py")
MASK = os.path.join(D, "tool_response_transform_secret_mask.py")


def hook(path, payload):
    r = subprocess.run([sys.executable, "-X", "utf8", path], input=json.dumps(payload), capture_output=True, text=True)
    o = json.loads(r.stdout)
    kind = "block" if o.get("decision") == "block" else ("rewrite" if o else "pass")
    return kind, o


def proxy(method, p, query=None, body=None):
    ti = {"environment_id": 3, "method": method, "path": p}
    if query is not None:
        ti["query_params"] = query
    if body is not None:
        ti["body"] = body
    return hook(POLICY, {"tool_name": "docker_proxy", "tool_input": ti})


def stack(tool, args):
    return hook(STACK, {"tool_name": tool, "tool_input": args})


def create(compose, **extra):
    return stack("StackCreateDockerStandaloneString", {"endpointId": 3, "Name": "myapp", "StackFileContent": compose, **extra})


WEB_DB = """
services:
  web:
    image: nginx:alpine
    ports: ["8080:80"]
    depends_on: [db]
    restart: unless-stopped
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: example
    volumes:
      - dbdata:/var/lib/postgresql/data
    mem_limit: 512m
volumes:
  dbdata:
"""

results = []


def check(name, got, exp, extra=None):
    ok = got == exp and (extra is None or extra)
    results.append(ok)
    print(("OK  " if ok else "XX  ") + name + ("" if ok else f"  (기대 {exp}, 결과 {got})"))


# ---- 4. 이미지·네트워크 삭제 DENY ----
check("4-1 이미지 삭제 거부", proxy("DELETE", "/images/nginx:latest")[0], "block")
check("4-2 네트워크 삭제 거부", proxy("DELETE", "/networks/app-net")[0], "block")
check("4-3 버전 접두 이미지 삭제 거부", proxy("DELETE", "/v1.43/images/nginx")[0], "block")
k, o = proxy("DELETE", "/containers/web")
check("4-4 컨테이너 삭제는 통과(11/1부터 경로를 전체 ID로 고정)", k, "rewrite",
      o.get("hook_specific_output", {}).get("updated_input", {}).get("path") == "/containers/" + fake_portainer.fake_id("web"))
check("4-5 컨테이너 강제 삭제 거부(기존)", proxy("DELETE", "/containers/web", {"force": "true"})[0], "block")

# ---- 3. 로그 ----
k, o = proxy("GET", "/containers/web/logs")
q = o.get("hook_specific_output", {}).get("updated_input", {}).get("query_params", {})
check("3-1 tail 없으면 100 채움", k, "rewrite", q.get("tail") == "100" and q.get("follow") == "false" and q.get("stdout") == "true")
k, o = proxy("GET", "/containers/web/logs", {"tail": "50", "stderr": "true"})
q = o.get("hook_specific_output", {}).get("updated_input", {}).get("query_params", {})
check("3-2 tail 50 유지, stderr만", k, "rewrite", q.get("tail") == "50" and "stdout" not in q)
check("3-3 tail 200 통과", proxy("GET", "/containers/web/logs", {"tail": "200"})[0], "rewrite")
check("3-4 tail 201 거부", proxy("GET", "/containers/web/logs", {"tail": "201"})[0], "block")
check("3-5 tail all 거부", proxy("GET", "/containers/web/logs", {"tail": "all"})[0], "block")
check("3-6 tail 0 거부", proxy("GET", "/containers/web/logs", {"tail": "0"})[0], "block")
check("3-7 follow=true 거부", proxy("GET", "/containers/web/logs", {"follow": "true", "tail": "10"})[0], "block")
check("3-8 모르는 키 거부", proxy("GET", "/containers/web/logs", {"tail": "10", "details": "true"})[0], "block")
check("3-9 since>until 거부", proxy("GET", "/containers/web/logs", {"since": "200", "until": "100"})[0], "block")
check("3-10 stdout·stderr 둘 다 false 거부", proxy("GET", "/containers/web/logs", {"stdout": "false", "stderr": "false"})[0], "block")

# ---- 2. 버전 접두어 정리(permissions가 정확한 경로로 판정하도록) ----
k, o = proxy("GET", "/v1.43/containers/json")
check("2-1 버전 접두어 제거", k, "rewrite", o.get("hook_specific_output", {}).get("updated_input", {}).get("path") == "/containers/json")
k, o = proxy("GET", "/containers/web/json", None, None)
check("2-2 inspect는 안전한 필드만 받도록 select를 채움(11/1, 승인은 permissions가 판단)", k, "rewrite",
      "composeProject" in o.get("hook_specific_output", {}).get("updated_input", {}).get("select", ""))
check("2-3 컨테이너 목록 통과", proxy("GET", "/containers/json")[0], "pass")

# ---- 1. 컨테이너 생성 → 스택 ----
check("1-1 /containers/create 거부", proxy("POST", "/containers/create", {"name": "web"}, {"Image": "nginx"})[0], "block")
k, o = create(WEB_DB)
check("1-2 웹+DB 스택 통과", k, "rewrite", "postgres:16" in o.get("hook_specific_output", {}).get("updated_input", {}).get("StackFileContent", ""))
check("1-3 privileged 거부", create("services:\n  a:\n    image: alpine\n    privileged: true\n")[0], "block")
check("1-4 cap_add 거부", create("services:\n  a:\n    image: alpine\n    cap_add: [SYS_ADMIN]\n")[0], "block")
check("1-5 호스트 폴더 마운트 거부", create("services:\n  a:\n    image: alpine\n    volumes: ['/:/host']\n")[0], "block")
check("1-6 docker.sock 거부", create("services:\n  a:\n    image: alpine\n    volumes: ['/var/run/docker.sock:/var/run/docker.sock']\n")[0], "block")
check("1-7 상대경로 마운트 거부", create("services:\n  a:\n    image: alpine\n    volumes: ['./data:/data']\n")[0], "block")
check("1-8 bind long 형식 거부", create("services:\n  a:\n    image: alpine\n    volumes:\n      - type: bind\n        source: /etc\n        target: /x\n")[0], "block")
check("1-9 network_mode host 거부", create("services:\n  a:\n    image: alpine\n    network_mode: host\n")[0], "block")
check("1-10 pid host 거부", create("services:\n  a:\n    image: alpine\n    pid: host\n")[0], "block")
check("1-11 devices 거부", create("services:\n  a:\n    image: alpine\n    devices: ['/dev/sda:/dev/sda']\n")[0], "block")
check("1-12 build 거부", create("services:\n  a:\n    build: .\n")[0], "block")
check("1-13 env_file 거부", create("services:\n  a:\n    image: alpine\n    env_file: /etc/passwd\n")[0], "block")
check("1-14 변수 치환 거부", create("services:\n  a:\n    image: alpine\n    volumes: ['${SRC}:/data']\nvolumes:\n  x:\n")[0], "block")
check("1-15 $$는 허용", create("services:\n  a:\n    image: alpine\n    command: echo $$HOME\n")[0], "rewrite")
check("1-16 Portainer 볼륨 거부", create("services:\n  a:\n    image: alpine\n    volumes: ['portainer_data:/data']\nvolumes:\n  portainer_data:\n    external: true\n")[0], "block")
check("1-17 driver_opts 볼륨 거부", create("services:\n  a:\n    image: alpine\n    volumes: ['v:/d']\nvolumes:\n  v:\n    driver_opts: {type: none, o: bind, device: /}\n")[0], "block")
check("1-18 선언 안 된 볼륨 거부", create("services:\n  a:\n    image: alpine\n    volumes: ['v:/d']\n")[0], "block")
check("1-19 macvlan 네트워크 거부", create("services:\n  a:\n    image: alpine\nnetworks:\n  lan:\n    driver: macvlan\n")[0], "block")
check("1-20 security_opt 거부", create("services:\n  a:\n    image: alpine\n    security_opt: ['seccomp:unconfined']\n")[0], "block")
check("1-21 secrets(호스트 파일) 거부", create("services:\n  a:\n    image: alpine\nsecrets:\n  s:\n    file: /etc/shadow\n")[0], "block")
check("1-22 extends 거부", create("services:\n  a:\n    extends: {file: /x.yml, service: b}\n    image: alpine\n")[0], "block")
check("1-23 중복 키 거부", create("services:\n  a:\n    image: alpine\n    image: busybox\n")[0], "block")
check("1-24 YAML 태그(!!python) 거부", create("services: !!python/object/apply:os.system ['id']\n")[0], "block")
check("1-25 대문자 스택 이름 거부", stack("StackCreateDockerStandaloneString", {"endpointId": 3, "Name": "MyApp", "StackFileContent": WEB_DB})[0], "block")
check("1-26 Webhook 거부", create(WEB_DB, Webhook="c11fdf23-183e-428a-9bb6-16db01032174")[0], "block")
check("1-27 Registries 거부", create(WEB_DB, Registries=[1])[0], "block")
check("1-28 Env 쌍 허용", create(WEB_DB, Env=[{"name": "A", "value": "b"}])[0], "rewrite")
check("1-29 endpointId 없음 거부", stack("StackCreateDockerStandaloneString", {"Name": "x", "StackFileContent": WEB_DB})[0], "block")
check("1-30 StackStart 통과", stack("StackStart", {"id": 4, "endpointId": 3})[0], "pass")
check("1-31 StackStop id 문자열 거부", stack("StackStop", {"id": "4", "endpointId": 3})[0], "block")
check("1-32 StackList 통과", stack("StackList", {})[0], "pass")
check("1-33 StackDelete 거부", stack("StackDelete", {"id": 4, "endpointId": 3})[0], "block")
check("1-34 ports long 형식 통과", create("services:\n  a:\n    image: nginx\n    ports:\n      - target: 80\n        published: 8080\n")[0], "rewrite")
check("1-35 services 없음 거부", create("version: '3'\n")[0], "block")
check("1-36 deploy.resources 통과", create("services:\n  a:\n    image: nginx\n    deploy:\n      resources:\n        limits: {cpus: '0.5', memory: 256M}\n")[0], "rewrite")
check("1-37 deploy.mode 거부", create("services:\n  a:\n    image: nginx\n    deploy:\n      mode: global\n")[0], "block")
check("1-38 container_name portainer 거부", create("services:\n  a:\n    image: nginx\n    container_name: portainer\n")[0], "block")

# ---- 2·3. 응답 비밀값 가리기 ----
def m(text):
    k, o = hook(MASK, {"tool_name": "docker_proxy", "tool_response": text})
    return o.get("hook_specific_output", {}).get("updated_tool_response", text)


t = m("2026-10-31 db connected password=hunter22 user=app")
check("M-1 로그의 password= 가림", "hunter22" in t, False)
t = m('{"Cmd":["--api-key","abcd1234efgh","--port","80"]}')
check("M-2 Cmd의 --api-key 값 가림", "abcd1234efgh" in t, False)
t = m("connecting to postgres://app:s3cretpw@db:5432/app")
check("M-3 URL 비밀번호 가림", "s3cretpw" in t, False)
t = m("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk")
check("M-4 Bearer 토큰 가림", "eyJhbGciOiJIUzI1NiJ9" in t, False)
t = m('{"Labels":{"GITHUB_TOKEN":"ghp_abcdefghijklmnopqrstuvwxyz0123456789"}}')
check("M-5 라벨의 토큰 가림", "ghp_abc" in t, False)
t = m("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----")
check("M-6 개인키 블록 가림", "MIIEpAIBAAKCAQEA" in t, False)
t = m('[{"id":"abc","name":"/web","state":"running"}]')
check("M-7 평범한 목록은 그대로", t, '[{"id":"abc","name":"/web","state":"running"}]')
t = m('{"Env":["POSTGRES_PASSWORD=[REDACTED]"]}')
check("M-8 이미 가린 값은 다시 안 건드림", t, '{"Env":["POSTGRES_PASSWORD=[REDACTED]"]}')
t = m("author: kim, tokenizer loaded")
check("M-9 author는 가리지 않음", "kim" in t, True)
t = m("Error: invalid token format")
check("M-10 일반 오류 문장은 그대로", t, "Error: invalid token format")
t = m("run --password hunter2 -x")
check("M-11 --password 값 가림", "hunter2" in t, False)

print(f"\n{sum(results)}/{len(results)} 통과")
sys.exit(0 if all(results) else 1)
