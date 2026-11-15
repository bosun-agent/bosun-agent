"""11/15 백업 창구 주소·네트워크 설정 테스트 (컨테이너 설치판 대비)
실행: python3 tests/policy_1115s_test.py   (ai-agent-hooks 폴더에서)
"""
import os
import subprocess
import sys
import tempfile

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, D)
import soteria_common as sc  # noqa: E402

results = []


def check(name, got, want, extra=True):
    ok = got == want and extra
    results.append(ok)
    print(("OK  " if ok else "XX  ") + name + ("" if ok else f"  (결과 {got!r:.300}, 기대 {want!r})"))


for k in ("SOTERIA_API", "SOTERIA_PORT", "SOTERIA_NETWORK", "AGENT_ENV_FILE"):
    os.environ.pop(k, None)

# 1) 주소
check("A1 기본은 맥·PC 직접 실행 주소", sc.api_base(), "http://127.0.0.1:18090")
os.environ["SOTERIA_PORT"] = "18099"
check("A2 SOTERIA_PORT를 따름", sc.api_base(), "http://127.0.0.1:18099")
os.environ.pop("SOTERIA_PORT")
os.environ["SOTERIA_API"] = "http://bosun-soteria:8080/"
check("A3 SOTERIA_API(설치판 이름 주소), 끝 / 정리", sc.api_base(), "http://bosun-soteria:8080")
os.environ["SOTERIA_API"] = "file:///etc/passwd"
check("A4 http(s)가 아니면 무시하고 기본 주소", sc.api_base(), "http://127.0.0.1:18090")
os.environ["SOTERIA_API"] = "http://evil.example/x?y"
check("A5 경로·쿼리가 붙은 주소도 무시", sc.api_base(), "http://127.0.0.1:18090")
os.environ.pop("SOTERIA_API")
envf = os.path.join(tempfile.mkdtemp(), "agent.env")
with open(envf, "w", encoding="utf-8") as f:
    f.write("# 비밀값 파일 예시(시험용 가짜)\nSOTERIA_API=http://bosun-soteria:8080\n")
os.environ["AGENT_ENV_FILE"] = envf
check("A6 환경변수가 없으면 agent.env의 SOTERIA_API", sc.api_base(), "http://bosun-soteria:8080")
os.environ["AGENT_ENV_FILE"] = os.path.join(tempfile.mkdtemp(), "none.env")
check("A7 agent.env가 없어도 기본 주소(오류 없음)", sc.api_base(), "http://127.0.0.1:18090")
os.environ.pop("AGENT_ENV_FILE")

# 2) 창구 Compose
T = {"web": ["web_data"], "db": ["db_data", "db_logs"]}
plain = sc.build_compose(T)
old = subprocess.run(["git", "-C", D, "show", "HEAD:ai-agent-hooks/soteria_common.py"], capture_output=True, text=True).stdout
ns = {}
if old:
    sys.modules.pop("soteria_common_old", None)
    exec(compile(old.replace("sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))", "sys.path.insert(0, %r)" % D),
                 "soteria_common_old", "exec"), ns)
check("C1 네트워크를 안 주면 예전과 같은 Compose", plain, ns["build_compose"](T) if ns else plain)
check("C2 네트워크를 안 주면 networks 없음", "networks" in plain, False)
os.environ["SOTERIA_NETWORK"] = "bosun_default"
net = sc.build_compose(T)
check("C3 네트워크를 주면 별칭 bosun-soteria로 붙음", "aliases: [bosun-soteria]" in net and "      bosun_default:" in net, True)
check("C4 기본 네트워크도 유지(Portainer 쪽 연결)", "      default: {}" in net, True)
check("C5 최상위 networks는 external", net.rstrip().endswith("networks:\n  bosun_default:\n    external: true"), True)
check("C6 호스트 발행은 그대로 127.0.0.1만", '"127.0.0.1:18090:8080"' in net and "0.0.0.0" not in net, True)
os.environ["SOTERIA_NETWORK"] = "bad name; rm"
try:
    sc.build_compose(T)
    check("C7 이상한 네트워크 이름은 거부", False, True)
except ValueError:
    check("C7 이상한 네트워크 이름은 거부", True, True)
os.environ.pop("SOTERIA_NETWORK")
with open(envf, "w", encoding="utf-8") as f:
    f.write("SOTERIA_NETWORK=bosun_default\n")
os.environ["AGENT_ENV_FILE"] = envf
check("C8 네트워크도 agent.env에서 읽음", "aliases: [bosun-soteria]" in sc.build_compose(T), True)
os.environ.pop("AGENT_ENV_FILE")

print(f"\n{sum(results)}/{len(results)} 통과")
