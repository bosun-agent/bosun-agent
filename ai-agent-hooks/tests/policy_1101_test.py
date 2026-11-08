"""11/1 정책 변경 단독 테스트 (Portainer·Docker 없이 훅만 실행)
실행: python3 tests/policy_1101_test.py   (ai-agent-hooks 폴더에서)
  - 스택 검사: restart 제한, 공개 포트 범위, 자원 상한과 기본값
  - 비밀값 가리기: Docker 로그 머리 제거, 오류 시 결과 숨김
  - 승인 카드 설명 훅
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fake_portainer  # noqa: E402,F401 — 11/1: 정책 훅이 컨테이너를 Portainer에 물어 ID로 고정하므로 가짜 Portainer를 띄운다
import tempfile

import yaml

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STACK = os.path.join(D, "tool_input_transform_stack_guard.py")
MASK = os.path.join(D, "tool_response_transform_secret_mask.py")


def hook(path, payload):
    r = subprocess.run([sys.executable, "-X", "utf8", path], input=json.dumps(payload), capture_output=True, text=True)
    o = json.loads(r.stdout)
    kind = "block" if o.get("decision") == "block" else ("rewrite" if o else "pass")
    return kind, o


def create(compose):
    return hook(STACK, {"tool_name": "StackCreateDockerStandaloneString",
                        "tool_input": {"endpointId": 3, "Name": "myapp", "StackFileContent": compose}})


def svc_after(compose):
    """통과했을 때 보정된 Compose의 첫 서비스."""
    k, o = create(compose)
    if k != "rewrite":
        return None
    doc = yaml.safe_load(o["hook_specific_output"]["updated_input"]["StackFileContent"])
    return next(iter(doc["services"].values()))


def mask(text):
    k, o = hook(MASK, {"tool_name": "docker_proxy", "tool_response": text})
    return o.get("hook_specific_output", {}).get("updated_tool_response", text)


results = []


def check(name, got, want, extra=True):
    ok = got == want and extra
    results.append(ok)
    print(("OK  " if ok else "XX  ") + name + ("" if ok else f"  (결과 {got}, 기대 {want})"))


NGX = "services:\n  web:\n    image: nginx:alpine\n"

# restart
for v, want in [('"no"', "rewrite"), ("no", "rewrite"), ("unless-stopped", "rewrite"), ('"on-failure:3"', "rewrite"),
                ('"on-failure:5"', "rewrite"), ("always", "block"), ("on-failure", "block"), ('"on-failure:6"', "block")]:
    check(f"R restart {v}", create(NGX + f"    restart: {v}\n")[0], want)

# 공개 포트
for p, want in [('"8080:80"', "rewrite"), ('"80"', "rewrite"), ('"127.0.0.1:8080:80"', "rewrite"), ('"1024:80"', "rewrite"),
                ('"80:80"', "block"), ('"443:443"', "block"), ('"9443:80"', "block"), ('"8000:80"', "block"),
                ('"7990-8010:80-100"', "block"), ('"127.0.0.1:22:22"', "block")]:
    check(f"P ports {p}", create(NGX + f"    ports: [{p}]\n")[0], want)
check("P ports long published 8080", create(NGX + "    ports:\n      - target: 80\n        published: 8080\n")[0], "rewrite")
check("P ports long published 80", create(NGX + "    ports:\n      - target: 80\n        published: 80\n")[0], "block")

# 자원 상한
for line, want in [("mem_limit: 512m", "rewrite"), ("mem_limit: 2g", "rewrite"), ("mem_limit: 3g", "block"),
                   ("mem_limit: 4096m", "block"), ("mem_reservation: 3g", "block"), ("cpus: 2", "rewrite"),
                   ("cpus: '0.5'", "rewrite"), ("cpus: 4", "block")]:
    check(f"M {line}", create(NGX + f"    {line}\n")[0], want)
check("M deploy limits 4G 거부", create(NGX + "    deploy:\n      resources:\n        limits: {memory: 4G}\n")[0], "block")
check("M deploy limits cpus 3 거부", create(NGX + "    deploy:\n      resources:\n        limits: {cpus: '3'}\n")[0], "block")

# 상한 기본값
s = svc_after(NGX)
check("D 상한 안 적으면 기본값(512m, 1) 채움", bool(s), True, bool(s) and s.get("mem_limit") == "512m" and s.get("cpus") == 1)
s = svc_after(NGX + "    mem_limit: 1g\n")
check("D 적은 값은 그대로 두고 빠진 cpus만 채움", bool(s), True, bool(s) and s.get("mem_limit") == "1g" and s.get("cpus") == 1)
s = svc_after(NGX + "    deploy:\n      resources:\n        limits: {cpus: '0.5', memory: 256M}\n")
check("D deploy.limits에 적었으면 mem_limit·cpus를 덧붙이지 않음", bool(s), True,
      bool(s) and "mem_limit" not in s and "cpus" not in s)

# 이미지 출처(Docker Hub 공식 이미지만)
POLICY = os.path.join(D, "tool_input_transform_direct_policy_guard.py")
sys.path.insert(0, D)
import image_source  # noqa: E402
for img, want in [("nginx", "rewrite"), ("nginx:alpine", "rewrite"), ("mysql:8.0", "rewrite"), ("docker.io/library/redis:7", "rewrite"),
                  ("library/postgres:16", "rewrite"), ("docker.io/nginx", "rewrite"), ("nginx@sha256:" + "a" * 64, "rewrite"),
                  ("bitnami/redis", "block"), ("someuser/ngnix", "block"), ("ghcr.io/owner/app:1", "block"),
                  ("quay.io/prometheus/prometheus", "block"), ("localhost:5000/app", "block")]:
    check(f"I 스택 image {img}", create(f"services:\n  web:\n    image: {img}\n")[0], want)
for img, want in [("nginx", "rewrite"), ("bitnami/redis", "block")]:
    k = hook(POLICY, {"tool_name": "docker_proxy", "tool_input": {"environment_id": 3, "method": "POST", "path": "/images/create",
                                                                  "query_params": {"fromImage": img, "tag": "latest"}}})[0]
    check(f"I 이미지 받기 {img}", "block" if k == "block" else "rewrite", want)
check("I 빈 이름은 거부", image_source.image_allowed(""), False)
check("I 거부 문구에 공식 대안 제안 안내 포함", "공식 이미지를 사용자에게 제안" in image_source.reject_text("bitnami/redis"), True)

# 비밀값 가리기
H = lambda n: "\x01\x00\x00\x00\x00\x00\x00" + chr(n)
check("S Docker 로그 머리 뒤 비밀번호 가림", "FakePass" in mask(H(0x1a) + "DB_PASSWORD=FakePass-1\n"), False)
check("S 길이 바이트가 글자 'A'여도 가림", "FakePass" in mask(H(0x41) + "password=FakePass-1\n"), False)
check("S 로그 머리 제거 후 머리 글자가 안 남음", "\x00" in mask(H(0x1a) + "DB_PASSWORD=FakePass-1\n"), False)
check("S 비밀값 없는 결과는 그대로", mask('[{"name":"web"}]'), '[{"name":"web"}]')
with tempfile.TemporaryDirectory() as t:
    broken = os.path.join(t, "mask_broken.py")
    src = open(MASK, encoding="utf-8").read().replace("def mask(text):", "def mask(text):\n    raise RuntimeError('test')\n\n\ndef _orig(text):", 1)
    open(broken, "w", encoding="utf-8").write(src)
    out = hook(broken, {"tool_name": "docker_proxy", "tool_response": "DB_PASSWORD=FakePass-1"})[1]
    hidden = out.get("hook_specific_output", {}).get("updated_tool_response", "")
    check("S 훅이 오류 나면 결과 전체를 숨김", "FakePass" in hidden, False, "숨겼습니다" in hidden)

# inspect 안전 필드(정책 훅이 select를 강제)
POL = os.path.join(D, "tool_input_transform_direct_policy_guard.py")
for path, key in [("/containers/web/json", "composeProject"), ("/images/nginx:alpine/json", "architecture"), ("/volumes/pgdata", "driver")]:
    o = hook(POL, {"tool_name": "docker_proxy", "tool_input": {"environment_id": 3, "method": "GET", "path": path, "select": "@"}})[1]
    sel = o.get("hook_specific_output", {}).get("updated_input", {}).get("select", "")
    check(f"F {path} 은 모델 select(@, 전체)를 안전 필드로 바꿈", sel != "@" and key in sel, True)
o = hook(POL, {"tool_name": "docker_proxy", "tool_input": {"environment_id": 3, "method": "GET", "path": "/containers/json"}})[1]
check("F 컨테이너 목록은 select를 건드리지 않음", "select" in o.get("hook_specific_output", {}).get("updated_input", {}), False)
o = hook(POL, {"tool_name": "docker_proxy", "tool_input": {"environment_id": 3, "method": "GET", "path": "/containers/web/json"}})[1]
check("F 안전 필드에 호스트 경로·라벨 전체가 없음", any(x in o["hook_specific_output"]["updated_input"]["select"] for x in ("GraphDriver", "LogPath", "Mountpoint", "Labels}")), False)

# 거부 안내 ①②③(deny_guide.py)
def reason_of(path, tool, ti):
    return hook(path, {"tool_name": tool, "tool_input": ti})[1].get("reason", "")


for title, path, tool, ti, frag in [
    ("이미지 삭제", POL, "docker_proxy", {"environment_id": 3, "method": "DELETE", "path": "/images/nginx"}, "되돌릴 수 없습니다"),
    ("exec", POL, "docker_proxy", {"environment_id": 3, "method": "POST", "path": "/containers/web/exec", "body": {"Cmd": ["ls"]}}, "로그 보기나 상세 보기"),
    ("컨테이너 직접 생성", POL, "docker_proxy", {"environment_id": 3, "method": "POST", "path": "/containers/create", "body": {"Image": "nginx"}}, "스택(Compose)으로 만들 수"),
    ("비공식 이미지 받기", POL, "docker_proxy", {"environment_id": 3, "method": "POST", "path": "/images/create", "query_params": {"fromImage": "bitnami/redis"}}, "공식 이미지를 쓰세요"),
    ("privileged", STACK, "StackCreateDockerStandaloneString", {"endpointId": 3, "Name": "x", "StackFileContent": NGX + "    privileged: true\n"}, "그 설정을 빼고"),
    ("호스트 폴더", STACK, "StackCreateDockerStandaloneString", {"endpointId": 3, "Name": "x", "StackFileContent": NGX + "    volumes: [\"/etc:/data\"]\n"}, "이름 있는 볼륨"),
    ("StackDelete", STACK, "StackDelete", {"id": 1, "endpointId": 3}, "관리자에게 요청"),
]:
    r = reason_of(path, tool, ti)
    check(f"G {title} 거부는 ①②③ 형식 + 알맞은 대안", all(x in r for x in ("① 막힌 것", "② 이유", "③ 대신 할 수 있는 것")), True, frag in r)
check("G Portainer에서 직접 하라는 안내는 없음", "Portainer 화면" in reason_of(POL, "docker_proxy", {"environment_id": 3, "method": "DELETE", "path": "/volumes/data"}), False)

# 컨테이너를 ID로 고정(정책 훅) — 가짜 Portainer 기준
def pol(method, path, **kw):
    return hook(POL, {"tool_name": "docker_proxy", "tool_input": {"environment_id": 3, "method": method, "path": path, **kw}})


k, o = pol("POST", "/containers/web/stop")
check("N 이름으로 온 정지 요청은 전체 ID 경로로 바뀜", o.get("hook_specific_output", {}).get("updated_input", {}).get("path"),
      "/containers/" + fake_portainer.fake_id("web") + "/stop")
k, o = pol("POST", "/containers/missing-app/stop")
check("N 없는 컨테이너는 거부 + 목록 확인 안내", k, "block", "목록을 먼저" in o.get("reason", ""))
k, o = pol("POST", "/containers/portainer/stop")
check("N 관리 도구(Portainer) 컨테이너 끄기는 거부", k, "block", "관리 도구" in o.get("reason", ""))
check("N Portainer 컨테이너 조회(GET)는 허용", pol("GET", "/containers/portainer/json")[0], "rewrite")
check("N 컨테이너 목록은 조회하지 않고 그대로", pol("GET", "/containers/json")[0], "pass")
check("N environment_id가 없으면 거부", hook(POL, {"tool_name": "docker_proxy", "tool_input": {"method": "POST", "path": "/containers/web/stop"}})[0], "block")

# 승인 카드 설명 훅
EXPL = os.path.join(D, "tool_guard_approval_explainer.py")


def meta(tool, ti):
    o = hook(EXPL, {"tool_name": tool, "tool_input": ti})[1]
    return o.get("hook_specific_output", {}).get("metadata", {})


m_ = meta("docker_proxy", {"environment_id": 3, "method": "POST", "path": "/containers/" + fake_portainer.fake_id("web") + "/stop"})
check("A ID로 온 요청도 이름으로 보여 줌", "'web' 컨테이너(" + fake_portainer.fake_id("web")[:12] + ")" in m_.get("reason", ""), True)
m_ = meta("StackStop", {"id": 4, "endpointId": 3})
check("A 스택은 'myweb' 스택(id 4)으로 보여 줌", "'myweb' 스택(id 4)" in m_.get("reason", ""), True)
m_ = meta("StackStop", {"id": 99, "endpointId": 3})
check("A 이름 조회 실패면 ID만 보여 줌", "스택(id 99)" in m_.get("reason", ""), True)
m_ = meta("docker_proxy", {"method": "DELETE", "path": "/containers/web"})
check("A 컨테이너 삭제는 영향 high", m_.get("blast_radius"), "high", "삭제" in m_.get("reason", ""))
m_ = meta("docker_proxy", {"method": "POST", "path": "/v1.43/containers/web/stop"})
check("A 버전 접두어가 붙어도 정지 설명", m_.get("category"), "container-stop")
m_ = meta("docker_proxy", {"method": "GET", "path": "/containers/web/logs", "query_params": {"tail": "50"}})
check("A 로그 설명에 tail 줄 수", "50줄" in m_.get("reason", ""), True)
m_ = meta("StackCreateDockerStandaloneString", {"Name": "myweb", "StackFileContent": NGX + "    ports: ['18081:80']\n    mem_limit: 512m\n    cpus: 1\n"})
check("A 스택 생성 설명에 이미지·포트·자원", all(x in m_.get("reason", "") for x in ("nginx:alpine", "18081→80", "512m")), True)
check("A 결정은 하지 않음(permission_decision 없음)", "permission_decision" in json.dumps(hook(EXPL, {"tool_name": "StackStop", "tool_input": {"id": 1}})[1]), False)
r = subprocess.run([sys.executable, "-X", "utf8", EXPL], input="not json", capture_output=True, text=True)
check("A 입력이 깨져도 오류 없이 {}(호출을 막지 않음)", (r.returncode, r.stdout.strip()), (0, "{}"))

print(f"\n{sum(results)}/{len(results)} 통과")
