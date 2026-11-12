#!/usr/bin/env python3
"""
tool_input_transform 훅 — soteria 백업 도구(backup_volume·backup_status) 검사 (11/12 정식. 볼륨 단위 — 11/12 시원 님 결정)

왜 필요한가 (11/9 soteria 테스트에서 찾은 문제와 팀원 지적)
  - 앱이 켜진 채 백업하면 깨진 백업이 "성공"으로 나온다 → 그 볼륨을 쓰는 컨테이너가 켜져 있으면 거부(먼저 정지)
  - 창구 재시작 뒤 같은 job_id로 예전 백업을 덮어쓴다 → job_id를 훅이 직접 만든다(앱·UTC 시각·무작위)
  - archive를 빼면 실패한다 → 항상 "/archive"
  - source를 아무 경로나 받는다(/etc, /archive) → 백업 대상 볼륨의 /backup/<볼륨>만
  - 보관 기간 등 다른 인자로 같은 폴더의 다른 앱 백업이 지워질 수 있다 → 정해진 인자 말고는 거부
  모델이 안내문을 지키는지에 기대지 않고 코드로 막는다. 조회에 실패하면 거부(fail-closed).

입력(모델이 보낸 것) → 보내는 것
  backup_volume {source(/backup/<볼륨>) 또는 volume(볼륨 이름, 또는 볼륨이 하나인 앱 이름), job_id?, archive?, wait?}
    → {source:"/backup/<볼륨>", archive:"/archive", job_id:"bosun-<볼륨 앞 40자>-<UTC시각>-<6자리>", volume:"<볼륨>", wait:true}
    볼륨이 여러 개인 앱 이름이면 거부하고 볼륨 목록을 알려 준다.
    백업 대상에 아직 없는 앱이면 한 번 sync_targets()로 목록을 맞춘 뒤 다시 본다(Portainer에서 직접 만든 앱 대비).
  backup_status {job_id} → job_id 형식만 검사

설정: soteria_common.py 맨 위 env 설명. 등록: tool_input_transform, matcher backup_volume·backup_status 각각, on_error: block
"""
import json
import os
import re
import secrets
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import portainer_api  # noqa: E402
import soteria_common as sc  # noqa: E402
from deny_guide import fmt, ADMIN  # noqa: E402

KEYS = {"source", "archive", "job_id", "volume", "wait"}
PREFIX = "백업 검사 훅이 이 요청을 거부했습니다."


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))


def block(what, why, alt):
    out({"decision": "block", "reason": fmt(PREFIX, what, why, alt)})


def requested(a):
    """모델이 말한 이름(source의 /backup/<이름> 또는 volume)."""
    src, vol = a.get("source"), a.get("volume")
    if isinstance(src, str):
        m = re.fullmatch(r"/backup/([A-Za-z0-9][A-Za-z0-9_.-]{0,254})/?", src)
        if m:
            return m.group(1)
        return None
    return vol if isinstance(vol, str) and sc.VOL_RE.fullmatch(vol) else None


def pick_volume(name, t):
    """(볼륨, 오류 문구). 볼륨 이름이면 그대로, 앱 이름이면 그 앱 볼륨이 하나일 때만."""
    vols = sc.all_volumes(t)
    if name in vols:
        return name, None
    if name in t:
        if len(t[name]) == 1:
            return t[name][0], None
        return None, f"multi:{name}"
    return None, None


def guard_backup(a):
    extra = sorted(k for k, v in a.items() if k not in KEYS and v is not None)
    if extra:
        return block(f"허용되지 않은 항목: {', '.join(extra)}", "보관 기간·파일 이름 등은 정해진 값만 씁니다(다른 앱 백업이 지워질 수 있음).",
                     "백업할 볼륨만 정해서 다시 요청하세요(나머지는 자동으로 채웁니다).")
    name = requested(a)
    if not name:
        return block(f"백업 위치 '{a.get('source') or a.get('volume')}'의 형식이 맞지 않습니다.",
                     "백업은 볼륨 하나씩, /backup/<볼륨 이름>으로만 합니다. 다른 경로는 엉뚱한 파일을 담을 수 있습니다.",
                     "source에 /backup/<볼륨 이름>을 넣으세요. 앱 이름만 알면 그 이름을 넣어도 됩니다(볼륨이 하나인 앱).")
    try:
        t = sc.targets()
        vol, err = pick_volume(name, t)
        if not vol and not err and name not in sc.MANAGED_STACKS and not sc.PROTECTED.search(name):
            sc.sync_targets()          # 목록에 없으면 한 번 맞춰 본다(Portainer에서 직접 만든 앱 대비)
            t = sc.targets()
            vol, err = pick_volume(name, t)
    except (portainer_api.PortainerError, OSError, ValueError) as e:
        return block(f"백업 대상 목록을 확인하지 못했습니다({e}).", "어떤 볼륨을 백업할 수 있는지 확인되지 않으면 백업하지 않습니다.",
                     "잠시 뒤 다시 시도하세요. 계속되면 관리자에게 알리세요.")
    if err and err.startswith("multi:"):
        app = err.split(":", 1)[1]
        return block(f"'{app}' 앱에는 데이터 볼륨이 {len(t[app])}개 있습니다: {', '.join(t[app])}.",
                     "백업은 볼륨 하나씩 합니다. 어느 볼륨인지 정해야 합니다.",
                     "필요한 볼륨마다 source를 /backup/<볼륨 이름>으로 해서 하나씩 백업하세요(앱은 한 번만 정지하면 됩니다).")
    if not vol:
        shown = ", ".join(sorted(sc.all_volumes(t))) or "(없음)"
        return block(f"'{name}'은(는) 백업 대상 볼륨이 아닙니다.",
                     "데이터(볼륨)가 있는 앱의 볼륨만 백업합니다. 관리용 볼륨과 다른 경로는 백업하지 않습니다.",
                     f"백업할 수 있는 볼륨: {shown}.")
    try:
        users = sc.running_users(vol)
    except portainer_api.PortainerError as e:
        return block(f"'{vol}' 볼륨을 쓰는 앱이 켜져 있는지 확인하지 못했습니다({e}).",
                     "켜진 채 백업하면 깨진 백업이 성공으로 나올 수 있어, 확인이 안 되면 백업하지 않습니다.",
                     "잠시 뒤 다시 시도하세요. 계속되면 관리자에게 알리세요.")
    if users:
        return block(f"'{vol}' 볼륨을 쓰는 앱이 켜져 있습니다: {', '.join(users)}.",
                     "앱이 쓰는 도중에 백업하면 반쯤 바뀐 파일이 담긴 깨진 백업이 될 수 있습니다.",
                     "먼저 그 앱(스택)을 StackStop으로 정지하고(승인), 백업한 뒤 StackStart로 다시 켜세요(승인).")
    job = f"bosun-{sc.job_label(vol)}-{time.strftime('%Y%m%dT%H%M%S', time.gmtime())}-{secrets.token_hex(3)}"
    out({"hook_specific_output": {"updated_input": {
        "source": f"/backup/{vol}", "archive": "/archive", "job_id": job, "volume": vol, "wait": True}}})


def guard_status(a):
    extra = sorted(k for k, v in a.items() if k != "job_id" and v is not None)
    if extra:
        return block(f"허용되지 않은 항목: {', '.join(extra)}", "결과 조회에는 job_id만 씁니다.", "job_id만 넣어 다시 조회하세요.")
    job = a.get("job_id")
    if not isinstance(job, str) or not sc.JOB_RE.fullmatch(job):
        return block(f"job_id '{job}'의 형식이 맞지 않습니다.", "백업 작업 번호는 백업할 때 훅이 정해서 결과에 돌려준 값입니다.",
                     "백업 결과에 나온 job_id(bosun-<앱>-<시각>-<6자리>)를 그대로 쓰세요.")
    out({})


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        tool = payload.get("tool_name")
        a = payload.get("tool_input") or {}
        if not isinstance(a, dict):
            return block("인자가 객체가 아닙니다.", "형식이 맞지 않는 요청은 보내지 않습니다.", "인자를 다시 확인하세요.")
        if tool == "backup_volume":
            return guard_backup(a)
        if tool == "backup_status":
            return guard_status(a)
        return block(f"'{tool}'는 이 훅이 아는 백업 도구가 아닙니다.", "알 수 없는 도구는 막습니다.", "backup_volume·backup_status만 쓰세요. " + ADMIN)
    except Exception as e:  # noqa: BLE001 — 훅 오류면 막는다(on_error: block과 같은 쪽)
        block(f"백업 검사 중 오류: {e}", "검사를 끝내지 못하면 실행하지 않습니다.", "잠시 뒤 다시 시도하세요. 계속되면 관리자에게 알리세요.")


if __name__ == "__main__":
    main()
