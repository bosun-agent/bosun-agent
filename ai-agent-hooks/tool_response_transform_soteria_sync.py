#!/usr/bin/env python3
"""
tool_response_transform 훅 — 새 앱 볼륨을 백업 대상에 자동으로 넣기 (11/12)

왜 필요한가
  soteria 백업 창구는 켤 때 연결한 볼륨만 백업할 수 있다. 사용자가 Agent로 새 앱을 만들 때마다 관리자가 손으로
  볼륨을 붙이면 안 되므로(11/9 시원 님), 앱을 만들거나 고친 직후 이 훅이 Portainer에서 앱 볼륨을 찾아
  백업 대상 목록과 창구 스택(bosun-soteria)을 맞춘다(soteria_common.sync_targets).

하는 일
  StackCreateDockerStandaloneString·StackUpdate·StackDelete(11/13)가 실행된 뒤(사용자가 승인해 실제로 실행된 뒤에만 불린다)
  그 앱 컨테이너가 보일 때까지 잠깐 기다렸다가 목록을 맞추고, 결과 끝에 한 줄을 덧붙인다.
  실패해도 앱 만들기 결과는 그대로 두고 "백업 대상 추가 실패"를 덧붙인다(이 훅 종류는 결과를 막지 못한다).
  다음에 그 앱 백업을 요청하면 백업 검사 훅이 한 번 더 맞춰 본다.
  11/15(A안): 같은 목록으로 정시 백업 스택(bosun-backup)도 맞춘다(scheduled_backup.sync). 관리자가 적은 볼륨은 그대로 둔다.

  11/19(팀원 시험 1번): 삭제 검사 훅은 승인 카드보다 먼저 돌아서(docker-agent에는 승인 뒤·실행 전 훅이 없다) 볼륨을 백업 창구·
  정시 백업에서 미리 뗀다. 사용자가 거부하거나 훅이 막아 실행되지 않았으면, 여기서 지금 상태로 다시 맞춰 뗀 볼륨을 되돌린다.
  실행되지 않은 요청에는 안내 문구를 붙이지 않는다(막힌 앱 만들기에 "[정시 백업] 넣었습니다"가 붙던 문제).
  docker_proxy의 볼륨 삭제·컨테이너 삭제(v=true)도 같은 이유로 결과 뒤에 다시 맞춘다(조용히).

등록: tool_response_transform, matcher StackCreateDockerStandaloneString·StackUpdate·StackDelete·docker_proxy 각각, timeout 150
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import soteria_common as sc  # noqa: E402


def scheduled_note(tool):
    """11/15 A안: 같은 백업 대상 목록으로 정시 백업(bosun-backup)도 맞춘다. 스택이 없으면 조용히 넘어간다."""
    try:
        import scheduled_backup
        r = scheduled_backup.sync(sc.targets())
    except Exception as e:  # noqa: BLE001
        return f"\n\n[정시 백업] 정시 백업 대상 맞추기에 실패했습니다({e}). 다음에 앱을 만들거나 고칠 때 다시 시도합니다."
    if not r or (tool == "StackDelete" and not r[1]) or (tool != "StackDelete" and not r[0]):
        return ""
    if tool == "StackDelete":
        return f"\n\n[정시 백업] 지운 앱의 볼륨 {', '.join(r[1])}을(를) 정시 백업에서 뺐습니다."
    return f"\n\n[정시 백업] 볼륨 {', '.join(r[0])}을(를) 정시 백업(매일 12·18·23시)에도 넣었습니다."


def quiet_sync():
    """안내 없이 지금 상태로 맞춘다(실행되지 않은 삭제로 떼어 둔 볼륨 되돌리기). 실패해도 결과는 그대로 둔다."""
    try:
        sc.sync_targets()
    except Exception:  # noqa: BLE001
        pass
    try:
        import scheduled_backup
        scheduled_backup.sync(sc.targets())
    except Exception:  # noqa: BLE001
        pass


def is_volume_delete(a):
    """docker_proxy 중 볼륨을 지울 수 있는 요청(볼륨 삭제, 컨테이너 삭제 v=true)인지."""
    if str(a.get("method") or "").upper() != "DELETE":
        return False
    path = re.sub(r"^/v\d+(\.\d+)?", "", str(a.get("path") or "").split("?")[0]).rstrip("/")
    return bool(re.fullmatch(r"/(volumes|containers)/[^/]+", path))


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        print("{}")
        return
    tool = payload.get("tool_name")
    a = payload.get("tool_input") or {}
    if tool == "docker_proxy":
        if isinstance(a, dict) and is_volume_delete(a):
            quiet_sync()
        print("{}")
        return
    if tool not in ("StackCreateDockerStandaloneString", "StackUpdate", "StackDelete"):
        print("{}")
        return
    resp = payload.get("tool_response")
    text = resp if isinstance(resp, str) else json.dumps(resp, ensure_ascii=False)
    if sc.tool_not_run(text):
        quiet_sync()   # 실행되지 않았다: 앱을 기다리지 않고, 안내도 붙이지 않는다
        print("{}")
        return
    name = a.get("Name") if isinstance(a.get("Name"), str) else None
    if not name:
        try:
            name = json.loads(text).get("Name")
        except (ValueError, AttributeError):
            name = None
    try:
        added, removed = sc.sync_targets(wait_for=None if tool == "StackDelete" else name)
        if tool == "StackDelete":   # 11/13: 지운 앱은 백업 대상에서 빠진다(백업 파일은 남음)
            note = (f"\n\n[백업 대상] 지운 앱 {', '.join(removed)}을(를) 백업 대상에서 뺐습니다. 이미 만든 백업 파일은 그대로 남습니다."
                    if removed else "")
            left = [v for v in sc.pop_pending_delete(a.get("id")) if sc.volume_exists(v)]
            if left:   # Portainer가 정지된 스택의 볼륨을 남기는 경우(11/13)
                note += (f"\n\n[남은 볼륨] 데이터까지 지우는 요청이었지만 볼륨 {', '.join(left)}이(가) 아직 남아 있습니다. "
                         "볼륨마다 docker_proxy DELETE /volumes/<이름>으로 삭제를 요청하세요(승인 1번씩, 백업은 이미 확인됨).")
        elif added:
            note = f"\n\n[백업 대상] 데이터가 있는 앱 {', '.join(added)}을(를) 백업 대상에 자동으로 넣었습니다."
        elif name and name in sc.targets():
            note = f"\n\n[백업 대상] '{name}'은(는) 백업 대상입니다."
        else:
            note = ""
    except Exception as e:  # noqa: BLE001 — 결과는 그대로 두고 알리기만 한다
        note = f"\n\n[백업 대상] 백업 대상 자동 추가에 실패했습니다({e}). 이 앱 백업을 요청하면 다시 시도합니다."
    note += scheduled_note(tool)
    if not note:
        print("{}")
        return
    print(json.dumps({"hook_specific_output": {"updated_tool_response": text + note}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
