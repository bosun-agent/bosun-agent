"""11/12 soteria 정식 결합 테스트 (가짜 Portainer 사용)
실행: python3 tests/policy_1112s_test.py   (ai-agent-hooks 폴더에서)
  - X: 컨테이너 안 명령 실행(exec)은 예외 없이 거부(백업 명령 예외 제거, 팀 결정)
  - B: backup_volume 검사(볼륨 단위, 켜진 앱 거부, 인자 자동 채우기, 모르는 인자 거부, 목록에 없으면 한 번 맞춰 봄)
  - S: backup_status job_id 형식
  - R: 성공 백업 기록
  - Y: 새 앱 볼륨 자동 추가(창구 스택 다시 배포)
  - G: 스택 수정 전 최근 백업 확인(SOTERIA_GATE=1)
  - P: BOSUN 포트(17080·3001·18090)는 앱이 못 씀, 관리 스택(bosun-soteria) 보호
  - E: 승인 카드(category backup-now)
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fake_portainer  # noqa: E402

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POLICY = os.path.join(D, "tool_input_transform_direct_policy_guard.py")
GUARD = os.path.join(D, "tool_input_transform_soteria_guard.py")
REC = os.path.join(D, "tool_response_transform_soteria_record.py")
SYNC = os.path.join(D, "tool_response_transform_soteria_sync.py")
STACK = os.path.join(D, "tool_input_transform_stack_guard.py")
EXPL = os.path.join(D, "tool_guard_approval_explainer.py")
TMP = tempfile.mkdtemp()
TARGETS = os.path.join(TMP, "soteria_targets.json")
RECORD = os.path.join(TMP, "soteria_runs.jsonl")
ENV = {"SOTERIA_TARGETS_FILE": TARGETS, "SOTERIA_ENDPOINT_ID": "3", "SOTERIA_RECORD": RECORD,
       "SOTERIA_HEALTH_WAIT": "0", "SOTERIA_PORT": "18090"}
results = []


def check(name, got, want, extra=True):
    ok = got == want and extra
    results.append(ok)
    print(("OK  " if ok else "XX  ") + name + ("" if ok else f"  (결과 {got}, 기대 {want})"))


def hook(path, payload, env=None):
    e = {**os.environ, **ENV, **(env or {})}
    r = subprocess.run([sys.executable, "-X", "utf8", path], input=json.dumps(payload), capture_output=True, text=True, env=e)
    o = json.loads(r.stdout or "{}")
    return ("block" if o.get("decision") == "block" else ("rewrite" if o.get("hook_specific_output") else "pass")), o


def upd(o):
    return o.get("hook_specific_output", {}).get("updated_input", {})


def bv(args, env=None):
    return hook(GUARD, {"tool_name": "backup_volume", "tool_input": args}, env)


def set_targets(t):
    with open(TARGETS, "w", encoding="utf-8") as f:
        json.dump(t, f)


# 가짜 Portainer 준비
fake_portainer.STACKS[12] = {"Id": 12, "Name": "bosun-soteria", "EndpointId": 3, "Type": 2, "_file": "services: {}\n"}
fake_portainer.STACK_MOUNTS.update({"myweb": ["myweb_data"], "shop": ["shop_db", "shop_files"]})
fake_portainer.VOLUME_USERS.update({
    "myweb_data": [("myweb-web-1", "exited", "myweb"), ("bosun-soteria-soteria-1", "running", "bosun-soteria"),
                   ("bosun-backup", "running", "bosun-backup")],
    "shop_db": [("shop-db-1", "running", "shop")], "shop_files": [("shop-web-1", "exited", "shop")]})
fake_portainer.VOLUME_SIZES.update({"myweb_data": 2 * 1024 ** 3, "shop_db": 10, "shop_files": 10})
set_targets({"myweb": ["myweb_data"], "shop": ["shop_db", "shop_files"]})

# X: exec 전부 거부
for label, path in [("백업 컨테이너 exec", "/containers/bosun-backup/exec"), ("다른 컨테이너 exec", "/containers/web/exec"),
                    ("exec 시작", "/exec/" + "a" * 64 + "/start"), ("버전 접두 exec", "/v1.43/containers/bosun-backup/exec")]:
    k, o = hook(POLICY, {"tool_name": "docker_proxy", "tool_input": {"environment_id": 3, "method": "POST", "path": path,
                                                                     "body": {"Cmd": ["backup"]}}})
    check(f"X1 {label} 거부", k, "block", "backup_volume" in o.get("reason", ""))

# B: backup_volume
k, o = bv({"source": "/backup/myweb_data"})
u = upd(o)
check("B1 볼륨을 쓰는 앱이 꺼져 있으면 통과(백업 창구·정시 백업 컨테이너는 무시)", k, "rewrite")
check("B2 source는 /backup/<볼륨>, archive /archive, wait true", (u.get("source"), u.get("archive"), u.get("wait"), u.get("volume")),
      ("/backup/myweb_data", "/archive", True, "myweb_data"))
check("B3 job_id는 훅이 만든 형식", bool(re.fullmatch(r"bosun-myweb_data-\d{8}T\d{6}-[0-9a-f]{6}", u.get("job_id", ""))), True)
check("B4 모델이 준 job_id는 무시(덮어쓰기 방지)", upd(bv({"source": "/backup/myweb_data", "job_id": "chat-1"})[1]).get("job_id", "") != "chat-1", True)
check("B5 볼륨이 하나인 앱 이름(volume: myweb)이면 그 볼륨으로", upd(bv({"volume": "myweb"})[1]).get("source"), "/backup/myweb_data")
check("B6 볼륨 단위: 같은 앱이라도 꺼진 컨테이너만 쓰는 볼륨(shop_files)은 통과", upd(bv({"volume": "shop_files"})[1]).get("source"), "/backup/shop_files")
k, o = bv({"source": "/backup/shop_db"})
check("B7 볼륨을 쓰는 컨테이너가 켜져 있으면 거부 + 정지 안내", k, "block",
      "shop-db-1" in o.get("reason", "") and "StackStop" in o.get("reason", ""))
k, o = bv({"source": "/backup/shop"})
check("B7b 볼륨이 여러 개인 앱 이름이면 거부 + 볼륨 목록 안내", k, "block",
      "shop_db" in o.get("reason", "") and "shop_files" in o.get("reason", ""))
for label, a in [("/etc", {"source": "/etc"}), ("/archive", {"source": "/archive"}), ("관리 스택", {"source": "/backup/bosun-backup"}),
                 ("경로 꼼수", {"source": "/backup/myweb_data/../../etc"}), ("빈 요청", {}), ("Portainer 볼륨", {"volume": "portainer_data"})]:
    check(f"B8 백업 대상 아님 거부: {label}", bv(a)[0], "block")
for key, val in [("retention_days", -1), ("filename", "x.tar.gz")]:
    check(f"B9 모르는/금지 인자 거부: {key}", bv({"source": "/backup/myweb_data", key: val})[0], "block")
check("B10 null 인자는 없는 것으로 봄", bv({"source": "/backup/myweb_data", "job_id": None})[0], "rewrite")
# 목록에 없는 앱 → 한 번 맞춰 봄
fake_portainer.STACK_MOUNTS["fresh"] = ["fresh_data"]
fake_portainer.VOLUME_USERS["fresh_data"] = [("fresh-app-1", "exited", "fresh")]
n_put = len(fake_portainer.PUTS)
k, o = bv({"source": "/backup/fresh_data"})
check("B11 목록에 없던 앱도 한 번 맞춘 뒤 통과(Portainer에서 직접 만든 앱 대비)", k, "rewrite",
      len(fake_portainer.PUTS) == n_put + 1 and "fresh" in json.load(open(TARGETS)))
saved = os.environ.pop("PORTAINER_URL")
check("B12 Portainer 조회 실패면 거부(fail-closed)", bv({"source": "/backup/myweb_data"})[0], "block")
os.environ["PORTAINER_URL"] = saved

# S
check("S1 형식 맞는 job_id 조회 통과", hook(GUARD, {"tool_name": "backup_status", "tool_input": {"job_id": u["job_id"]}})[0], "pass")
check("S2 형식 틀린 job_id 거부", hook(GUARD, {"tool_name": "backup_status", "tool_input": {"job_id": "../x"}})[0], "block")

# R
ok_resp = json.dumps({"job_id": u["job_id"], "volume": "myweb_data", "status": "succeeded",
                      "artifact": {"name": "job-x.tar.gz", "size": 226, "sha256": "ab" * 32}})
k, o = hook(REC, {"tool_name": "backup_volume", "tool_response": ok_resp})
check("R1 성공 결과는 기록(기록의 app 칸 = 볼륨 이름)", k == "rewrite" and json.loads(open(RECORD).read().splitlines()[-1])["app"] == "myweb_data", True)
n = len(open(RECORD).read().splitlines())
hook(REC, {"tool_name": "backup_volume", "tool_response": json.dumps({"job_id": "j", "volume": "myweb", "status": "failed"})})
check("R2 실패 결과는 기록 안 함", len(open(RECORD).read().splitlines()), n)

# Y: 자동 추가
fake_portainer.STACK_MOUNTS["newapp"] = ["newapp_data"]
n_put = len(fake_portainer.PUTS)
k, o = hook(SYNC, {"tool_name": "StackCreateDockerStandaloneString", "tool_input": {"Name": "newapp"},
                   "tool_response": json.dumps({"Id": 30, "Name": "newapp"})})
note = o.get("hook_specific_output", {}).get("updated_tool_response", "")
check("Y1 새 앱을 만들면 백업 대상에 자동 추가 + 안내 한 줄", "newapp" in note and "자동으로 넣었습니다" in note, True)
put = fake_portainer.PUTS[-1] if len(fake_portainer.PUTS) > n_put else {}
comp = (put.get("body") or {}).get("StackFileContent", "")
check("Y2 창구 스택(id 12)을 다시 배포", put.get("id"), 12)
check("Y3 새 볼륨은 /backup/<볼륨>에 읽기 전용", "v_newapp_data:/backup/newapp_data:ro" in comp and "name: newapp_data" in comp, True)
check("Y4 창구는 127.0.0.1에만 열림", '"127.0.0.1:18090:8080"' in comp, True)
check("Y5 다시 배포할 때 Prune·PullImage는 false", (put.get("body") or {}).get("Prune") is False and (put.get("body") or {}).get("PullImage") is False, True)
check("Y6 관리 스택·Portainer 볼륨은 대상에 넣지 않음",
      "bosun-backup" not in json.load(open(TARGETS)) and "portainer" not in json.dumps(json.load(open(TARGETS))), True)
n_put = len(fake_portainer.PUTS)
k, o = hook(SYNC, {"tool_name": "StackUpdate", "tool_input": {"id": 4}, "tool_response": json.dumps({"Name": "myweb"})})
check("Y7 바뀐 게 없으면 다시 배포하지 않음", len(fake_portainer.PUTS), n_put)
del fake_portainer.STACKS[12]
fake_portainer.STACK_MOUNTS["another"] = ["another_data"]
k, o = hook(SYNC, {"tool_name": "StackCreateDockerStandaloneString", "tool_input": {"Name": "another"}, "tool_response": "{}"})
check("Y8 창구 스택이 없으면 실패를 알리기만(결과는 그대로)", "자동 추가에 실패" in o.get("hook_specific_output", {}).get("updated_tool_response", ""), True)
fake_portainer.STACKS[12] = {"Id": 12, "Name": "bosun-soteria", "EndpointId": 3, "Type": 2, "_file": ""}

# G: 스택 수정 전 최근 백업
NEW = "services:\n  web:\n    image: nginx:alpine\n    volumes: [\"d:/data\"]\nvolumes:\n  d: {}\n"
args = {"id": 4, "endpointId": 3, "StackFileContent": NEW}
check("G1 SOTERIA_GATE 없으면 기록과 상관없이 통과", hook(STACK, {"tool_name": "StackUpdate", "tool_input": args},
                                                 {"SOTERIA_RECORD": RECORD + ".none"})[0], "rewrite")
k, o = hook(STACK, {"tool_name": "StackUpdate", "tool_input": args}, {"SOTERIA_GATE": "1", "SOTERIA_RECORD": RECORD + ".none"})
check("G2 데이터 있는 앱 + 최근 백업 없음 → 거부 + 정지·백업 안내", k, "block", "backup_volume" in o.get("reason", ""))
check("G3 30분 안 기록 있으면 통과", hook(STACK, {"tool_name": "StackUpdate", "tool_input": args}, {"SOTERIA_GATE": "1"})[0], "rewrite")
old = os.path.join(TMP, "old.jsonl")
with open(old, "w", encoding="utf-8") as f:
    f.write(json.dumps({"app": "myweb_data", "sha256": "cd" * 32, "recorded_at": time.time() - 3600}) + "\n")
check("G4 기록이 30분보다 오래되면 거부", hook(STACK, {"tool_name": "StackUpdate", "tool_input": args},
                                         {"SOTERIA_GATE": "1", "SOTERIA_RECORD": old})[0], "block")
fake_portainer.STACKS[14] = {"Id": 14, "Name": "shop", "EndpointId": 3, "Type": 2, "_file": ""}
with open(RECORD, "a", encoding="utf-8") as f:
    f.write(json.dumps({"app": "shop_files", "sha256": "ef" * 32, "recorded_at": time.time()}) + "\n")
k, o = hook(STACK, {"tool_name": "StackUpdate", "tool_input": {"id": 14, "endpointId": 3, "StackFileContent": NEW}}, {"SOTERIA_GATE": "1"})
check("G4b 볼륨이 여러 개인 앱은 볼륨 하나라도 백업이 없으면 거부(빠진 볼륨 이름 안내)", k, "block", "shop_db" in o.get("reason", ""))
fake_portainer.STACKS[13] = {"Id": 13, "Name": "nodata", "EndpointId": 3, "Type": 2, "_file": "services:\n  w:\n    image: nginx\n"}
check("G5 데이터가 없는 앱은 기록 없어도 통과", hook(STACK, {"tool_name": "StackUpdate", "tool_input": {"id": 13, "endpointId": 3,
      "StackFileContent": "services:\n  w:\n    image: nginx:alpine\n"}}, {"SOTERIA_GATE": "1", "SOTERIA_RECORD": RECORD + ".none"})[0], "rewrite")

# P: 포트·관리 스택
def create(compose):
    return hook(STACK, {"tool_name": "StackCreateDockerStandaloneString",
                        "tool_input": {"endpointId": 3, "Name": "portapp", "StackFileContent": compose}})


for port, who in [(17080, "Agent"), (3001, "웹"), (18090, "백업 창구")]:
    k, o = create(f"services:\n  w:\n    image: nginx:alpine\n    ports: [\"{port}:80\"]\n")
    check(f"P1 호스트 포트 {port}({who}) 거부", k, "block", str(port) in o.get("reason", ""))
check("P2 범위에 17080이 들어가도 거부", create("services:\n  w:\n    image: nginx:alpine\n    ports: [\"17000-17100:80\"]\n")[0], "block")
check("P3 8081은 통과", create("services:\n  w:\n    image: nginx:alpine\n    ports: [\"8081:80\"]\n")[0], "rewrite")
check("P4 관리 스택 bosun-soteria 끄기 거부", hook(STACK, {"tool_name": "StackStop", "tool_input": {"id": 12, "endpointId": 3}})[0], "block")

# E: 승인 카드
o = hook(EXPL, {"tool_name": "backup_volume", "tool_input": {"source": "/backup/myweb_data", "volume": "myweb_data"}})[1]
md = o.get("hook_specific_output", {}).get("metadata", {})
check("E1 카드 category backup-now", md.get("category"), "backup-now")
check("E2 카드에 앱·볼륨 이름·크기·예상 시간·꺼져 있어야 함", all(x in md.get("reason", "") for x in ("'myweb'", "myweb_data", "2.0GB", "초", "꺼져")), True)
o = hook(EXPL, {"tool_name": "backup_status", "tool_input": {"job_id": u["job_id"]}})[1]
check("E3 결과 조회 카드 category backup-status", o.get("hook_specific_output", {}).get("metadata", {}).get("category"), "backup-status")

print(f"\n{sum(results)}/{len(results)} 통과")
