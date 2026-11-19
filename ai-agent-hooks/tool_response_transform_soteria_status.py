#!/usr/bin/env python3
"""
tool_response_transform 훅 — 백업 결과 조회(backup_status) 보강 (11/19, 팀원 시험 7번)

왜 필요한가
  - 백업 창구(bosun-soteria)는 작업 목록을 메모리에만 둔다. 창구가 다시 배포되면(앱 생성·수정 때 대상 맞추기,
    볼륨 삭제 전 떼기, soteria_setup 재실행) 예전 job_id를 못 찾는다. 성공한 백업은 기록 파일(SOTERIA_RECORD)에 남아 있다.
  - job_id 없이는 최근 목록을 볼 수 없어 AI가 job_id를 지어냈다.
  - 시각이 UTC로 나와 AI가 그대로 한국 시간처럼 말했다.

하는 일
  - 입력 훅이 job_id 없는 조회에 넣은 번호(soteria_common.LIST_JOB)면: 결과를 기록 파일의 최근 백업 목록(한국 시간)으로 바꾼다.
  - 창구가 작업을 찾았으면: 결과 끝에 시작·끝 시각의 한국 시간을 덧붙인다.
  - 창구가 못 찾았으면: 기록 파일에서 같은 job_id를 찾아 덧붙인다. 기록에도 없으면 "지어내지 말 것"과 최근 목록을 덧붙인다.
  이 훅 종류는 결과를 막지 못한다. 오류가 나면 결과를 그대로 둔다.

등록: tool_response_transform, matcher "backup_status", env SOTERIA_RECORD
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import soteria_common as sc  # noqa: E402
from tool_response_transform_soteria_record import find_result  # noqa: E402


def times_note(r):
    parts = []
    for key, label in (("started_at", "시작"), ("finished_at", "끝")):
        t = sc.kst(r.get(key)) if r.get(key) else None
        if t:
            parts.append(f"{label} {t}")
    return f"\n\n[한국 시간] {', '.join(parts)}. 사용자에게는 이 시각으로 말한다." if parts else ""


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    if payload.get("tool_name") != "backup_status":
        return "{}"
    job = (payload.get("tool_input") or {}).get("job_id")
    resp = payload.get("tool_response")
    text = resp if isinstance(resp, str) else json.dumps(resp, ensure_ascii=False)
    if sc.tool_not_run(text):
        return "{}"
    if job == sc.LIST_JOB:
        new = "[백업 목록] " + sc.records_text()
    else:
        r = find_result(resp)
        if r and r.get("status"):
            note = times_note(r)
            if not note:
                return "{}"
            new = text + note
        else:
            rec = sc.find_record(job) if isinstance(job, str) else None
            if rec:
                new = (text + "\n\n[백업 기록] 백업 창구가 다시 시작되어 작업 목록에서는 사라졌지만, 기록 파일에 성공한 백업으로 남아 있습니다.\n"
                       + sc.record_line(rec))
            else:
                new = (text + "\n\n[백업 기록] 이 job_id는 기록 파일에도 없습니다. job_id를 지어내지 말고, 아래 목록에 있는 것만 쓰세요.\n"
                       + sc.records_text())
    return json.dumps({"hook_specific_output": {"updated_tool_response": new}}, ensure_ascii=False)


if __name__ == "__main__":
    try:
        print(main())
    except Exception:  # noqa: BLE001 — 결과는 그대로 둔다
        print("{}")
