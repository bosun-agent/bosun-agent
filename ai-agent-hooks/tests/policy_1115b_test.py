"""11/15 정시 백업(bosun-backup)에 새 앱 볼륨 자동 넣기 테스트 (A안, 가짜 Portainer 사용)
실행: python3 tests/policy_1115b_test.py   (ai-agent-hooks 폴더에서)
  - S: scheduled_backup.sync/detach — 관리자 볼륨·설정은 그대로, 훅이 넣은 볼륨(auto_)만 바뀜
  - H: 삭제 전 검사 — 훅이 넣은 볼륨은 막지 않고, 관리자가 적은 볼륨은 계속 막음
  - Y: 앱 만들기·지우기 결과 훅이 정시 백업도 맞추고 한 줄 안내
"""
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fake_portainer  # noqa: E402

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, D)
SYNC = os.path.join(D, "tool_response_transform_soteria_sync.py")
TMP = tempfile.mkdtemp()
TARGETS = os.path.join(TMP, "soteria_targets.json")
ENV = {"SOTERIA_TARGETS_FILE": TARGETS, "SOTERIA_ENDPOINT_ID": "3", "SOTERIA_RECORD": os.path.join(TMP, "runs.jsonl"),
       "SOTERIA_HEALTH_WAIT": "0", "SOTERIA_PORT": "18090"}
os.environ.update(ENV)
for k in ("SOTERIA_NETWORK", "SOTERIA_API", "SCHEDULED_BACKUP_STACK"):
    os.environ.pop(k, None)
import portainer_api  # noqa: E402
import scheduled_backup as sb  # noqa: E402
import soteria_common as sc  # noqa: E402
import yaml  # noqa: E402

results = []


def check(name, got, want, extra=True):
    ok = got == want and extra
    results.append(ok)
    print(("OK  " if ok else "XX  ") + name + ("" if ok else f"  (결과 {got!r:.300}, 기대 {want!r})"))


ADMIN_FILE = """services:
  backup:
    image: offen/docker-volume-backup:v2.50.1
    container_name: bosun-backup
    restart: unless-stopped
    environment:
      BACKUP_CRON_EXPRESSION: "0 12,18,23 * * *"
      TZ: "Asia/Seoul"
      BACKUP_RETENTION_DAYS: "7"
    mem_limit: 256m
    volumes:
      - bosun-data-1102:/backup/bosun-data-1102:ro
      - bosun_backups:/archive
volumes:
  bosun-data-1102:
    external: true
    name: bosun-data-1102_data
  bosun_backups:
    name: bosun_backups
"""


def reset():
    fake_portainer.STACKS[5]["_file"] = ADMIN_FILE
    fake_portainer.STACKS[5]["Env"] = [{"name": "X", "value": "1"}]


def doc():
    return yaml.safe_load(fake_portainer.STACKS[5]["_file"])


def mounts():
    return doc()["services"]["backup"]["volumes"]


fake_portainer.STACKS[12] = {"Id": 12, "Name": "bosun-soteria", "EndpointId": 3, "Type": 2, "_file": "services: {}\n"}
reset()

# S: 맞추기
n = len(fake_portainer.PUTS)
r = sb.sync({"shop": ["shop_db", "shop_files"], "old": ["bosun-data-1102_data"]})
check("S1 새 앱 볼륨을 넣음(관리자가 이미 적은 볼륨은 다시 안 넣음)", r, (["shop_db", "shop_files"], []))
check("S2 정시 백업 스택(id 5)을 다시 배포", fake_portainer.PUTS[-1]["id"] if len(fake_portainer.PUTS) > n else None, 5)
check("S3 읽기 전용 /backup/<볼륨>, auto_ 키", "auto_shop_db:/backup/shop_db:ro" in mounts(), True)
check("S4 auto_ 볼륨은 external + 실제 이름", doc()["volumes"]["auto_shop_db"], {"external": True, "name": "shop_db"})
d = doc()
check("S5 관리자 볼륨·보관 볼륨 그대로", "bosun-data-1102:/backup/bosun-data-1102:ro" in mounts() and "bosun_backups:/archive" in mounts()
      and d["volumes"]["bosun-data-1102"]["name"] == "bosun-data-1102_data", True)
check("S6 시간·시간대·보관 기간·자원 설정 그대로", (d["services"]["backup"]["environment"]["BACKUP_CRON_EXPRESSION"],
      d["services"]["backup"]["environment"]["TZ"], d["services"]["backup"]["mem_limit"]), ("0 12,18,23 * * *", "Asia/Seoul", "256m"))
put = fake_portainer.PUTS[-1]["body"]
check("S7 스택 환경값(Env) 유지, Prune·PullImage false", (put["Env"], put["Prune"], put["PullImage"]), ([{"name": "X", "value": "1"}], False, False))
n = len(fake_portainer.PUTS)
check("S8 바뀐 게 없으면 다시 배포 안 함", (sb.sync({"shop": ["shop_db", "shop_files"]}), len(fake_portainer.PUTS)), (([], []), n))
check("S9 훅이 넣은 볼륨 목록", sb.auto_volumes(), {"shop_db", "shop_files"})
r = sb.sync({"shop": ["shop_db"]})
check("S10 앱 볼륨이 빠지면 auto_만 뺌", (r, "auto_shop_files" in doc()["volumes"], "bosun-data-1102" in doc()["volumes"]),
      (([], ["shop_files"]), False, True))
check("S11 detach는 훅이 넣은 볼륨만 뗌(관리자 볼륨 요청은 무시)", (sb.detach(["shop_db", "bosun-data-1102_data"]), sb.auto_volumes(),
      "bosun-data-1102:/backup/bosun-data-1102:ro" in mounts()), (True, set(), True))
check("S12 뗄 게 없으면 False", sb.detach(["nothing"]), False)
os.environ["SCHEDULED_BACKUP_STACK"] = "no-such-stack"
check("S13 정시 백업 스택이 없으면 None(아무것도 안 함)", (sb.sync({"shop": ["shop_db"]}), sb.auto_volumes(), sb.detach(["shop_db"])), (None, set(), False))
os.environ.pop("SCHEDULED_BACKUP_STACK")
fake_portainer.STACKS[5]["_file"] = "services:\n  a: {}\n  b: {}\n"
try:
    sb.sync({"shop": ["shop_db"]})
    got = "no error"
except portainer_api.PortainerError:
    got = "PortainerError"
check("S14 파일 모양이 이상하면 PortainerError(호출한 쪽이 거부)", got, "PortainerError")
fake_portainer.STACKS[5]["_file"] = "services: [\n"
try:
    sb.auto_volumes()
    got = "no error"
except portainer_api.PortainerError:
    got = "PortainerError"
check("S15 YAML이 깨져도 PortainerError", got, "PortainerError")
reset()

# H: 삭제 전 검사
sb.sync({"shop": ["shop_db"]})
fake_portainer.VOLUME_USERS["shop_db"] = [("bosun-backup", "running", "bosun-backup")]
fake_portainer.VOLUME_USERS["bosun-data-1102_data"] = [("bosun-backup", "running", "bosun-backup")]
check("H1 훅이 넣은 볼륨은 정시 백업이 잡고 있어도 막지 않음", sc.scheduled_backup_holders("shop_db"), [])
check("H2 관리자가 적은 볼륨은 계속 막음", sc.scheduled_backup_holders("bosun-data-1102_data"), ["bosun-backup"])
with open(TARGETS, "w", encoding="utf-8") as f:
    json.dump({"shop": ["shop_db"]}, f)
sc.detach(["shop_db"])
check("H3 삭제 직전 detach가 정시 백업에서도 뗌", ("shop_db" in sb.auto_volumes(), json.load(open(TARGETS))), (False, {}))
fake_portainer.VOLUME_USERS.clear()
reset()


# Y: 결과 훅
def hook(payload):
    r = subprocess.run([sys.executable, "-X", "utf8", SYNC], input=json.dumps(payload), capture_output=True, text=True,
                       env={**os.environ, **ENV})
    o = json.loads(r.stdout or "{}")
    return o.get("hook_specific_output", {}).get("updated_tool_response", "")


with open(TARGETS, "w", encoding="utf-8") as f:
    json.dump({}, f)
fake_portainer.STACK_MOUNTS.clear()
fake_portainer.STACK_MOUNTS["newapp"] = ["newapp_data"]
note = hook({"tool_name": "StackCreateDockerStandaloneString", "tool_input": {"Name": "newapp"},
             "tool_response": json.dumps({"Id": 30, "Name": "newapp"})})
check("Y1 새 앱을 만들면 정시 백업에도 넣고 안내", "[정시 백업]" in note and "newapp_data" in note and "12·18·23시" in note, True)
check("Y2 soteria 안내도 그대로", "자동으로 넣었습니다" in note, True)
check("Y3 정시 백업 스택에 실제로 들어감", "auto_newapp_data:/backup/newapp_data:ro" in mounts(), True)
note = hook({"tool_name": "StackUpdate", "tool_input": {"Name": "newapp"}, "tool_response": "{}"})
check("Y4 바뀐 게 없으면 정시 백업 안내 없음", "[정시 백업]" in note, False)
fake_portainer.STACK_MOUNTS.clear()
note = hook({"tool_name": "StackDelete", "tool_input": {"id": 30}, "tool_response": "{}"})
check("Y5 앱을 지우면 정시 백업에서도 빼고 안내", "[정시 백업]" in note and "뺐습니다" in note and "auto_newapp_data" not in str(doc()), True)
fake_portainer.STACKS[5]["_file"] = "services: [\n"
fake_portainer.STACK_MOUNTS["other"] = ["other_data"]
note = hook({"tool_name": "StackCreateDockerStandaloneString", "tool_input": {"Name": "other"},
             "tool_response": json.dumps({"Id": 31, "Name": "other"})})
check("Y6 정시 백업 맞추기가 실패해도 결과는 그대로, 실패 안내", "자동으로 넣었습니다" in note and "정시 백업 대상 맞추기에 실패" in note, True)

print(f"{sum(results)}/{len(results)} 통과")
sys.exit(0 if all(results) else 1)
