#!/usr/bin/env python3
"""
tool_response_transform 훅 — 새 앱 볼륨을 백업 대상에 자동으로 넣기 (11/12)

왜 필요한가
  soteria 백업 창구는 켤 때 연결한 볼륨만 백업할 수 있다. 사용자가 Agent로 새 앱을 만들 때마다 관리자가 손으로
  볼륨을 붙이면 안 되므로(11/9 시원 님), 앱을 만들거나 고친 직후 이 훅이 Portainer에서 앱 볼륨을 찾아
  백업 대상 목록과 창구 스택(bosun-soteria)을 맞춘다(soteria_common.sync_targets).

하는 일
  StackCreateDockerStandaloneString·StackUpdate가 실행된 뒤(사용자가 승인해 실제로 실행된 뒤에만 불린다)
  그 앱 컨테이너가 보일 때까지 잠깐 기다렸다가 목록을 맞추고, 결과 끝에 한 줄을 덧붙인다.
  실패해도 앱 만들기 결과는 그대로 두고 "백업 대상 추가 실패"를 덧붙인다(이 훅 종류는 결과를 막지 못한다).
  다음에 그 앱 백업을 요청하면 백업 검사 훅이 한 번 더 맞춰 본다.

등록: tool_response_transform, matcher StackCreateDockerStandaloneString·StackUpdate 각각, timeout 150
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import soteria_common as sc  # noqa: E402


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        print("{}")
        return
    tool = payload.get("tool_name")
    if tool not in ("StackCreateDockerStandaloneString", "StackUpdate"):
        print("{}")
        return
    resp = payload.get("tool_response")
    text = resp if isinstance(resp, str) else json.dumps(resp, ensure_ascii=False)
    a = payload.get("tool_input") or {}
    name = a.get("Name") if isinstance(a.get("Name"), str) else None
    if not name:
        try:
            name = json.loads(text).get("Name")
        except (ValueError, AttributeError):
            name = None
    try:
        added, removed = sc.sync_targets(wait_for=name)
        if added:
            note = f"\n\n[백업 대상] 데이터가 있는 앱 {', '.join(added)}을(를) 백업 대상에 자동으로 넣었습니다."
        elif name and name in sc.targets():
            note = f"\n\n[백업 대상] '{name}'은(는) 백업 대상입니다."
        else:
            note = ""
    except Exception as e:  # noqa: BLE001 — 결과는 그대로 두고 알리기만 한다
        note = f"\n\n[백업 대상] 백업 대상 자동 추가에 실패했습니다({e}). 이 앱 백업을 요청하면 다시 시도합니다."
    if not note:
        print("{}")
        return
    print(json.dumps({"hook_specific_output": {"updated_tool_response": text + note}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
