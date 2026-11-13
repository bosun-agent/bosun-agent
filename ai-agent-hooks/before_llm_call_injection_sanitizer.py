#!/usr/bin/env python3
"""
before_llm_call 훅 — 차단된 사용자 입력을 모델 호출 직전에 가린다.

왜 필요한가
  docker-agent는 사용자 메시지를 세션에 먼저 저장한 뒤 user_prompt_submit 훅을 실행한다
  (v1.148.0 pkg/runtime/hooks.go executeUserPromptSubmitHooks). 훅이 차단해도 그 턴만 멈추고
  메시지는 세션에 남아, 다음 메시지를 보내면 모델이 차단된 메시지에 답한다(WEB 담당 실측).
  before_llm_call은 모델에 보낼 대화 전체(messages)를 받고, 바꾼 목록(updated_messages)을
  돌려주면 그것이 모델에 전달된다(공식 내장 redact_secrets와 같은 방식).
  steer·followup으로 들어온 입력도 이 시점에는 대화에 들어 있으므로 함께 가려진다.

동작
  role이 user인 메시지 중 injection_patterns.scan에 걸리는 것의 내용을 안내 문구로 바꾼다.
  세션 기록(session.db)은 바뀌지 않는다(감사 기록으로 남는다). 바꿀 것이 없으면 {}.

입출력
  입력: {"messages": [{"role": "...", "content": "...", "multi_content": [...]}, ...], ...}
  출력: {} 또는 {"hook_specific_output": {"updated_messages": [...]}}
등록: before_llm_call(matcher 없음), on_error: block(실패 시 모델 호출을 하지 않음)
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from injection_patterns import scan  # noqa: E402

PLACEHOLDER = "[보안 정책으로 차단된 사용자 입력입니다. 이 메시지에는 응답하지 않습니다.]"


def main():
    raw = sys.stdin.read().strip()
    payload = json.loads(raw) if raw else {}
    messages = payload.get("messages") or []
    changed = False
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "user":
            continue
        texts = [msg.get("content") or ""]
        for part in msg.get("multi_content") or []:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                texts.append(part["text"])
        if scan("\n".join(texts)):
            msg["content"] = PLACEHOLDER
            if msg.get("multi_content"):
                msg["multi_content"] = [{"type": "text", "text": PLACEHOLDER}]
            changed = True
    if changed:
        print(json.dumps({"hook_specific_output": {"updated_messages": messages}}, ensure_ascii=False))
    else:
        print("{}")


if __name__ == "__main__":
    main()
