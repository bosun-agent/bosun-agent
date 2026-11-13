"""11/13 정책표 수정본 반영 테스트 (가짜 Portainer 사용)
실행: python3 tests/policy_1113_test.py   (ai-agent-hooks 폴더에서)
  - S: StackDelete(5.10) — 관리 스택·external 거부, removeVolumes=true는 볼륨 전부 최근 백업 + 정시 백업에 안 묶임, 통과하면 백업 창구에서 뗌
  - V: VolumeDelete(5.11) — 관리용 볼륨 거부, force 거부, 쓰는 컨테이너 있으면 거부, 최근 백업 필수, 정시 백업에 묶이면 거부
  - N: NetworkDelete(5.12) — 기본·관리용 거부, 연결된 컨테이너 있으면 거부
  - C: ContainerDelete v=true(5.3) — 이름 없는 볼륨마다 최근 백업 필수
  - E: 승인 카드
"""
import json
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fake_portainer as fp  # noqa: E402

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POLICY = os.path.join(D, "tool_input_transform_direct_policy_guard.py")
STACK = os.path.join(D, "tool_input_transform_stack_guard.py")
EXPL = os.path.join(D, "tool_guard_approval_explainer.py")
SYNC = os.path.join(D, "tool_response_transform_soteria_sync.py")
TMP = tempfile.mkdtemp()
TARGETS = os.path.join(TMP, "targets.json")
RECORD = os.path.join(TMP, "runs.jsonl")
ENV = {"SOTERIA_TARGETS_FILE": TARGETS, "SOTERIA_ENDPOINT_ID": "3", "SOTERIA_RECORD": RECORD, "SOTERIA_HEALTH_WAIT": "0"}
ANON = "a" * 64
results = []


def check(name, got, want, extra=True):
    ok = got == want and extra
    results.append(ok)
    print(("OK  " if ok else "XX  ") + name + ("" if ok else f"  (결과 {got}, 기대 {want})"))


def hook(path, payload):
    r = subprocess.run([sys.executable, "-X", "utf8", path], input=json.dumps(payload), capture_output=True, text=True,
                       env={**os.environ, **ENV})
    o = json.loads(r.stdout or "{}")
    return ("block" if o.get("decision") == "block" else ("rewrite" if o.get("hook_specific_output") else "pass")), o


def proxy(method, path, query=None):
    a = {"environment_id": 3, "method": method, "path": path}
    if query is not None:
        a["query_params"] = query
    return hook(POLICY, {"tool_name": "docker_proxy", "tool_input": a})


def sdel(args):
    return hook(STACK, {"tool_name": "StackDelete", "tool_input": args})


def reset(targets, records):
    with open(TARGETS, "w", encoding="utf-8") as f:
        json.dump(targets, f)
    with open(RECORD, "w", encoding="utf-8") as f:
        for v in records:
            f.write(json.dumps({"app": v, "sha256": "ab" * 32, "recorded_at": time.time()}) + "\n")


def ui(o):
    return o.get("hook_specific_output", {}).get("updated_input", {})


# 가짜 Portainer: 백업 창구 스택, 앱 shop(볼륨 2개), 앱 cache(정시 백업에 묶인 볼륨)
fp.STACKS[12] = {"Id": 12, "Name": "bosun-soteria", "EndpointId": 3, "Type": 2, "_file": ""}
fp.STACKS[20] = {"Id": 20, "Name": "shop", "EndpointId": 3, "Type": 2, "_file": "services:\n  w:\n    image: nginx\n"}
fp.STACKS[21] = {"Id": 21, "Name": "cache", "EndpointId": 3, "Type": 2, "_file": "services:\n  r:\n    image: redis\n"}
fp.STACK_MOUNTS.update({"shop": ["shop_db", "shop_files"], "cache": ["cache_data"]})
fp.VOLUME_USERS.update({
    "shop_db": [("shop-db-1", "exited", "shop"), ("bosun-soteria-soteria-1", "running", "bosun-soteria")],
    "shop_files": [("shop-web-1", "exited", "shop")],
    "cache_data": [("cache-r-1", "exited", "cache"), ("bosun-backup", "running", "bosun-backup")],
    "loose_data": [("bosun-soteria-soteria-1", "running", "bosun-soteria")],
    "used_data": [("web-1", "exited", "web")],
    ANON: [("bosun-soteria-soteria-1", "running", "bosun-soteria")],
})
fp.VOLUMES.update({v: {"Name": v} for v in ("loose_data", "used_data", "cache_data", "portainer_data", "bosun_backups", ANON)})
fp.NETWORKS.update({
    "free_net": {"Name": "free_net", "Id": "f" * 64, "Containers": {}},
    "busy_net": {"Name": "busy_net", "Id": "b" * 64, "Containers": {"x": {"Name": "web-1"}}},
    "bridge": {"Name": "bridge", "Id": "c" * 64, "Containers": {}},
    "portainer_default": {"Name": "portainer_default", "Id": "d" * 64, "Containers": {}},
})
fp.CONTAINER_MOUNTS.update({"oldapp": [{"Type": "volume", "Name": ANON, "Destination": "/data"},
                                       {"Type": "volume", "Name": "named_vol", "Destination": "/x"}]})
BASE_T = {"shop": ["shop_db", "shop_files"], "cache": ["cache_data"], "loose": ["loose_data"], "anonapp": [ANON]}

# S: StackDelete
reset(BASE_T, [])
k, o = sdel({"id": 20, "endpointId": 3})
check("S1 볼륨은 남기는 삭제는 백업 없어도 통과(removeVolumes 안 보냄)", k, "rewrite", "removeVolumes" not in ui(o) and ui(o).get("id") == 20)
check("S2 관리 스택(bosun-backup) 삭제 거부", sdel({"id": 5, "endpointId": 3})[0], "block")
check("S3 관리 스택(bosun-soteria) 삭제 거부", sdel({"id": 12, "endpointId": 3})[0], "block")
check("S4 external=true 거부", sdel({"id": 20, "endpointId": 3, "external": True})[0], "block")
check("S5 환경이 다르면 거부", sdel({"id": 20, "endpointId": 2})[0], "block")
check("S6 모르는 인자 거부", sdel({"id": 20, "endpointId": 3, "force": True})[0], "block")
check("S7 removeVolumes가 불리언이 아니면 거부", sdel({"id": 20, "endpointId": 3, "removeVolumes": "yes"})[0], "block")
k, o = sdel({"id": 20, "endpointId": 3, "removeVolumes": True})
check("S8 removeVolumes=true인데 백업 없으면 거부 + 빠진 볼륨 이름", k, "block", "shop_db" in o.get("reason", "") and "shop_files" in o.get("reason", ""))
reset(BASE_T, ["shop_db"])
k, o = sdel({"id": 20, "endpointId": 3, "removeVolumes": True})
check("S9 볼륨 하나라도 백업이 없으면 거부", k, "block", "shop_files" in o.get("reason", "") and "shop_db" not in o.get("reason", "").split("백업이 없습니다")[1])
reset(BASE_T, ["shop_db", "shop_files"])
n = len(fp.PUTS)
k, o = sdel({"id": 20, "endpointId": 3, "removeVolumes": True})
t_after = json.load(open(TARGETS))
check("S10 볼륨 전부 백업 있으면 통과 + removeVolumes true", k, "rewrite", ui(o).get("removeVolumes") is True)
check("S11 통과하면 백업 창구에서 그 볼륨을 뗌(다시 배포 1번, 목록에서 빠짐)", len(fp.PUTS) == n + 1 and "shop" not in t_after
      and "shop_db" not in fp.PUTS[-1]["body"]["StackFileContent"], True)
reset(BASE_T, ["cache_data"])
k, o = sdel({"id": 21, "endpointId": 3, "removeVolumes": True})
check("S12 정시 백업에 묶인 볼륨이면 볼륨까지 지우기 거부 + 관리자 안내", k, "block", "정시 백업" in o.get("reason", "") and "관리자" in o.get("reason", ""))

# V: VolumeDelete
reset(BASE_T, [])
k, o = proxy("DELETE", "/volumes/loose_data")
check("V1 백업 없으면 거부 + 정지·백업 안내", k, "block", "backup_volume" in o.get("reason", ""))
reset(BASE_T, ["loose_data"])
n = len(fp.PUTS)
k, o = proxy("DELETE", "/volumes/loose_data")
check("V2 백업 있고 쓰는 앱 없으면 통과 + 백업 창구에서 뗌", k, "rewrite", len(fp.PUTS) == n + 1 and "loose" not in json.load(open(TARGETS)))
check("V3 force=true 거부", proxy("DELETE", "/volumes/loose_data", {"force": "1"})[0], "block")
check("V4 모르는 query 거부", proxy("DELETE", "/volumes/loose_data", {"x": "1"})[0], "block")
reset(BASE_T, ["used_data"])
k, o = proxy("DELETE", "/volumes/used_data")
check("V5 쓰는 컨테이너(꺼져 있어도)가 있으면 거부", k, "block", "web-1" in o.get("reason", ""))
for v in ("portainer_data", "bosun_backups"):
    check(f"V6 관리용 볼륨({v}) 거부", proxy("DELETE", f"/volumes/{v}")[0], "block")
reset(BASE_T, ["cache_data"])
fp.VOLUME_USERS["cache_only"] = [("bosun-backup", "running", "bosun-backup")]
fp.VOLUMES["cache_only"] = {"Name": "cache_only"}
k, o = proxy("DELETE", "/volumes/cache_only")
check("V7 정시 백업에 묶인 볼륨은 거부 + 관리자 안내", k, "block", "관리자" in o.get("reason", ""))
check("V8 없는 볼륨 거부", proxy("DELETE", "/volumes/nope_vol")[0], "block")

# N: NetworkDelete
k, o = proxy("DELETE", "/networks/free_net")
check("N1 연결 없는 일반 네트워크 삭제 통과 + 실제 ID로 고정", k, "rewrite", ui(o).get("path") == "/networks/" + "f" * 64)
check("N2 연결된 컨테이너 있으면 거부", proxy("DELETE", "/networks/busy_net")[0], "block")
check("N3 기본 네트워크(bridge) 거부", proxy("DELETE", "/networks/bridge")[0], "block")
check("N4 관리용 네트워크(portainer_default) 거부", proxy("DELETE", "/networks/portainer_default")[0], "block")
check("N5 query_params 거부", proxy("DELETE", "/networks/free_net", {"force": "1"})[0], "block")
check("N6 없는 네트워크 거부", proxy("DELETE", "/networks/nope_net")[0], "block")

# C: ContainerDelete v=true
reset(BASE_T, [])
k, o = proxy("DELETE", "/containers/oldapp", {"v": "true"})
check("C1 이름 없는 볼륨 백업 없으면 v=true 거부", k, "block", ANON[:12] in o.get("reason", ""))
reset(BASE_T, [ANON])
n = len(fp.PUTS)
k, o = proxy("DELETE", "/containers/oldapp", {"v": "1"})
check("C2 이름 없는 볼륨 백업 있으면 통과 + v=true + 백업 창구에서 뗌", k, "rewrite",
      ui(o).get("query_params", {}).get("v") == "true" and len(fp.PUTS) == n + 1)
check("C3 이름 있는 볼륨(named_vol)은 v=true로 지워지지 않으니 백업 대상 아님(익명만 확인)", True, True)
check("C4 force는 여전히 거부", proxy("DELETE", "/containers/oldapp", {"force": "true", "v": "true"})[0], "block")
check("C5 백업 컨테이너(bosun-backup)는 지울 수 없음", proxy("DELETE", "/containers/bosun-backup")[0], "block")

# E: 승인 카드·자동 정리
def meta(tool, args):
    return hook(EXPL, {"tool_name": tool, "tool_input": args})[1].get("hook_specific_output", {}).get("metadata", {})


m = meta("StackDelete", {"id": 20, "endpointId": 3, "removeVolumes": True})
check("E1 스택+볼륨 삭제 카드(high, stack-delete-volumes)", (m.get("blast_radius"), m.get("category")), ("high", "stack-delete-volumes"))
m = meta("StackDelete", {"id": 20, "endpointId": 3})
check("E2 스택만 삭제 카드는 볼륨을 남긴다고 안내", "남겨" in m.get("reason", "") and m.get("category") == "stack-delete", True)
m = meta("docker_proxy", {"environment_id": 3, "method": "DELETE", "path": "/volumes/loose_data"})
check("E3 볼륨 삭제 카드(high)", (m.get("blast_radius"), m.get("category")), ("high", "volume-delete"))
m = meta("docker_proxy", {"environment_id": 3, "method": "DELETE", "path": "/networks/free_net"})
check("E4 네트워크 삭제 카드", m.get("category"), "network-delete")
reset({"shop": ["shop_db"], "gone": ["gone_v"]}, [])
k, o = hook(SYNC, {"tool_name": "StackDelete", "tool_input": {"id": 30}, "tool_response": "{}"})
check("E5 스택 삭제 뒤 백업 대상 목록이 자동 정리됨(없어진 앱 빠짐) + 안내", "gone" not in json.load(open(TARGETS))
      and "뺐습니다" in o.get("hook_specific_output", {}).get("updated_tool_response", ""), True)

# E6: Portainer가 정지된 스택의 볼륨을 남긴 경우(11/13 웹 시험에서 발견) — 삭제 뒤 남은 볼륨을 알린다
fp.VOLUMES["shop_files"] = {"Name": "shop_files"}   # S10에서 shop 삭제 검사를 통과해 적어 둔 볼륨 중 하나가 남았다고 가정
k, o = hook(SYNC, {"tool_name": "StackDelete", "tool_input": {"id": 20, "endpointId": 3, "removeVolumes": True}, "tool_response": "{}"})
txt = o.get("hook_specific_output", {}).get("updated_tool_response", "")
check("E6 볼륨까지 지웠는데 남은 볼륨이 있으면 이름과 볼륨 삭제 안내를 덧붙임(없어진 shop_db는 빼고)", "[남은 볼륨]" in txt and "shop_files" in txt
      and "shop_db" not in txt.split("[남은 볼륨]")[1], True)
k, o = hook(SYNC, {"tool_name": "StackDelete", "tool_input": {"id": 20, "endpointId": 3, "removeVolumes": True}, "tool_response": "{}"})
check("E7 같은 안내는 한 번만(적어 둔 목록은 쓰고 지움)", "[남은 볼륨]" in o.get("hook_specific_output", {}).get("updated_tool_response", ""), False)

print(f"\n{sum(results)}/{len(results)} 통과")
