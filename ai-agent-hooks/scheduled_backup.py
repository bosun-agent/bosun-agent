"""정시 백업(bosun-backup)에 새 앱 볼륨 자동 넣기 (11/15 시원 님 결정 A안)

정시 백업은 offen/docker-volume-backup 스택 bosun-backup이 맡는다(매일 12·18·23시, 배포 서버는 항상 켜져 있다).
예전에는 관리자가 볼륨을 손으로 적어야 해서 Agent로 만든 새 앱은 정시 백업에 들어가지 않았다.
이제 soteria 자동 추가(soteria_common.sync_targets)와 같은 때에, 같은 백업 대상 목록으로 이 스택도 맞춘다.

나누는 기준
  - 관리자가 적은 볼륨: 그대로 둔다. Agent가 떼지 않는다(11/13 ㉠ 유지, 삭제 요청은 거부).
  - 훅이 넣은 볼륨: 볼륨 키가 auto_로 시작한다. 앱을 지우면 훅이 뗀다(soteria 창구와 같이).
  스택 파일의 그 밖의 설정(이미지·시간·보관 기간·시간대·자원 제한)은 건드리지 않는다.

훅 env
  SCHEDULED_BACKUP_STACK  정시 백업 스택 이름(기본 bosun-backup). 이 스택이 없으면 아무것도 하지 않는다
  SOTERIA_ENDPOINT_ID     Portainer 환경 ID(soteria와 같은 값)
"""
import os
import re
import sys

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import portainer_api  # noqa: E402

AUTO = "auto_"
ARCHIVE_MOUNT = "/archive"


def stack_name():
    return os.environ.get("SCHEDULED_BACKUP_STACK") or "bosun-backup"


def endpoint():
    return int(os.environ.get("SOTERIA_ENDPOINT_ID", "0") or 0)


def find_stack():
    for st in portainer_api.get("/api/stacks", timeout=10) or []:
        if st.get("Name") == stack_name() and st.get("EndpointId") == endpoint():
            return st
    return None


def _load(st):
    text = portainer_api.get(f"/api/stacks/{st['Id']}/file", timeout=10).get("StackFileContent", "")
    try:
        doc = yaml.safe_load(text) or {}
    except yaml.YAMLError as e:
        raise portainer_api.PortainerError(f"정시 백업 스택 파일을 읽지 못했습니다({e}).")
    services = doc.get("services") if isinstance(doc, dict) else None
    if not isinstance(services, dict) or len(services) != 1:
        raise portainer_api.PortainerError("정시 백업 스택 파일 모양이 예상과 다릅니다(서비스가 하나여야 합니다).")
    return doc, next(iter(services))


def _vol_name(doc, key):
    """Compose 볼륨 키 → 실제 Docker 볼륨 이름(name: 이 있으면 그것)."""
    spec = (doc.get("volumes") or {}).get(key)
    return spec.get("name", key) if isinstance(spec, dict) and spec.get("name") else key


def _split(doc, svc):
    """(관리자 볼륨 이름 집합, 훅이 넣은 볼륨 이름 집합)"""
    admin, auto = set(), set()
    for m in (doc["services"][svc].get("volumes") or []):
        if not isinstance(m, str) or ":" not in m:
            continue
        key, target = m.split(":")[0], m.split(":")[1]
        if target == ARCHIVE_MOUNT:
            continue
        (auto if key.startswith(AUTO) else admin).add(_vol_name(doc, key))
    return admin, auto


def _key(vol):
    return AUTO + re.sub(r"[^A-Za-z0-9_]", "_", vol)[:120]


def _apply(doc, svc, auto_vols):
    """훅이 넣은 볼륨을 auto_vols로 바꾼 새 문서."""
    s = doc["services"][svc]
    mounts = [m for m in (s.get("volumes") or []) if not (isinstance(m, str) and m.startswith(AUTO))]
    top = {k: v for k, v in (doc.get("volumes") or {}).items() if not k.startswith(AUTO)}
    for vol in sorted(auto_vols):
        k = _key(vol)
        mounts.append(f"{k}:/backup/{vol}:ro")
        top[k] = {"external": True, "name": vol}
    s["volumes"] = mounts
    doc["volumes"] = top
    return doc


def auto_volumes():
    """훅이 넣은 볼륨 이름 집합. 스택이 없으면 빈 집합. 조회 실패·파일 모양이 이상하면 PortainerError."""
    st = find_stack()
    if not st:
        return set()
    doc, svc = _load(st)
    return _split(doc, svc)[1]


def _redeploy(st, doc):
    portainer_api.request_json("PUT", f"/api/stacks/{st['Id']}?endpointId={endpoint()}",
                               {"StackFileContent": yaml.safe_dump(doc, sort_keys=False, allow_unicode=True),
                                "Env": st.get("Env") or [], "Prune": False, "PullImage": False}, timeout=180)


def sync(targets):
    """백업 대상 목록({앱: [볼륨]})의 볼륨을 정시 백업에 맞춘다. 관리자가 이미 적은 볼륨은 다시 넣지 않는다.
    돌려주는 값: (넣은 볼륨, 뺀 볼륨) 또는 스택이 없으면 None. 실패하면 PortainerError."""
    st = find_stack()
    if not st:
        return None
    doc, svc = _load(st)
    admin, auto = _split(doc, svc)
    want = {v for vols in targets.values() for v in vols} - admin
    if want == auto:
        return [], []
    _redeploy(st, _apply(doc, svc, want))
    return sorted(want - auto), sorted(auto - want)


def detach(vols):
    """훅이 넣은 볼륨 중 vols를 뗀다(삭제 직전). 관리자 볼륨은 건드리지 않는다. 바뀐 게 없으면 False."""
    st = find_stack()
    if not st:
        return False
    doc, svc = _load(st)
    _, auto = _split(doc, svc)
    left = auto - set(vols)
    if left == auto:
        return False
    _redeploy(st, _apply(doc, svc, left))
    return True
