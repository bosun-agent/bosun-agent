#!/usr/bin/env python3
"""
tool_response_transform 훅 — soteria 백업 결과 기록 (11/12 정식. 11/9 시험 결합본)

하는 일
  backup_volume 결과가 "succeeded"이고 지문(sha256)이 있으면, 앱·job_id·지문·크기·시각을 SOTERIA_RECORD 파일에 한 줄 남긴다.
  스택 검사 훅이 스택 수정 전에 이 기록으로 "최근 성공 백업"을 확인한다(순서 보장, 팀원 지적).
  결과에 한 줄을 덧붙여 모델에게 기록 여부를 알린다. 실패 결과는 기록하지 않는다.
  결과 내용은 바꾸지 않는다(덧붙이기만). 이 훅 종류는 결과를 막지 못한다.

등록: tool_response_transform, matcher "backup_volume"
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import soteria_common as sc  # noqa: E402


def find_result(resp):
    """도구 결과에서 soteria JSON을 찾는다. 문자열·객체·MCP content 목록 모두 처리."""
    if isinstance(resp, dict):
        if "job_id" in resp:
            return resp
        for c in resp.get("content") or []:
            r = find_result(c.get("text") if isinstance(c, dict) else c)
            if r:
                return r
        return None
    if isinstance(resp, list):
        for x in resp:
            r = find_result(x)
            if r:
                return r
        return None
    if isinstance(resp, str):
        m = re.search(r"\{.*\}", resp, re.S)
        if m:
            try:
                return find_result(json.loads(m.group(0)))
            except ValueError:
                return None
    return None


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if payload.get("tool_name") != "backup_volume":
            print("{}")
            return
        resp = payload.get("tool_response")
        r = find_result(resp)
        art = (r or {}).get("artifact") or {}
        if not r or r.get("status") != "succeeded" or not art.get("sha256"):
            print("{}")
            return
        rec = {"app": r.get("volume"), "job_id": r.get("job_id"), "sha256": art.get("sha256"), "size": art.get("size"),
               "name": art.get("name"), "finished_at": r.get("finished_at"), "recorded_at": time.time()}
        ok = sc.add_record(rec)
        note = ("\n\n[백업 기록] 이 백업을 기록했습니다. 30분 안에 이 앱의 스택 수정을 할 수 있습니다."
                if ok else "\n\n[백업 기록] 기록 파일 설정이 없어 기록하지 못했습니다(스택 수정 전 확인에 쓰이지 않음).")
        text = resp if isinstance(resp, str) else json.dumps(resp, ensure_ascii=False)
        print(json.dumps({"hook_specific_output": {"updated_tool_response": text + note}}, ensure_ascii=False))
    except Exception:  # noqa: BLE001 — 기록 실패해도 결과는 그대로 둔다
        print("{}")


if __name__ == "__main__":
    main()
