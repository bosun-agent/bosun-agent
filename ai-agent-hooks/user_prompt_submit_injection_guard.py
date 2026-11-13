#!/usr/bin/env python3
"""
user_prompt_submit 훅 — 인젝션 1차 방어 (입력 레이어).

입출력(docker-agent v1.148.0에서 실제 실행으로 확인):
  입력(stdin JSON): {"prompt": "<사용자가 제출한 텍스트>", "session_id": "...", ...}
  출력(stdout JSON):
    통과 → {}                                          (아무것도 안 바꿈)
    차단 → {"decision": "block", "reason": "<사유>"}   (실행 자체가 중단됨)

차단 시 반드시 로그를 남긴다 — user_prompt_submit에서 막힌 건 Airlock이 아예
보지 못하는 유일한 구간이라, 이 로그가 사후 감사의 유일한 기록이 된다.

agent.yaml 등록 형식(도구 이벤트가 아니므로 matcher 없이 훅 목록으로 등록):
  hooks:
    user_prompt_submit:
      - type: command
        command: python3 /절대경로/user_prompt_submit_injection_guard.py
        timeout: 10
"""
import json
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from injection_patterns import scan  # noqa: E402

LOG_DB = os.environ.get(
    "AI_AGENT_INJECTION_LOG_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "injection_log.sqlite3"),
)


def _log_block(session_id: str, hits, prompt: str):
    conn = sqlite3.connect(LOG_DB)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS blocked_prompts "
        "(ts REAL, session_id TEXT, matched_rules TEXT, prompt_excerpt TEXT)"
    )
    conn.execute(
        "INSERT INTO blocked_prompts VALUES (?, ?, ?, ?)",
        (time.time(), session_id or "", ",".join(hits), prompt[:500]),
    )
    conn.commit()
    conn.close()


def _read_input() -> dict:
    raw = sys.stdin.read().strip()
    if raw:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass
    return {}


def main():
    payload = _read_input()
    # user_prompt_submit·user_followup_submit은 prompt, user_steering_messages_submit은 steering_messages로 온다.
    prompt = payload.get("prompt", "") or "\n".join(payload.get("steering_messages") or [])
    session_id = payload.get("session_id") or ""

    hits = scan(prompt)
    if hits:
        try:
            _log_block(session_id, hits, prompt)
        except Exception as exc:  # noqa: BLE001 — 로그 실패가 차단 자체를 막으면 안 된다
            sys.stderr.write(f"injection log write failed: {exc}\n")
        print(json.dumps({
            "decision": "block",
            "reason": "입력에서 비정상적인 패턴이 감지되어 처리하지 않았습니다. 다시 작성해 주세요.",
        }, ensure_ascii=False))
        return

    # 애매하면 통과 — 확실한 패턴이 아니면 막지 않는다(설계 원칙).
    print("{}")


if __name__ == "__main__":
    main()
