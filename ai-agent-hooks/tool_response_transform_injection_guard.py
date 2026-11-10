#!/usr/bin/env python3
"""
tool_response_transform 훅 — 인젝션 1차 방어 (도구 결과 레이어).

입출력(docker-agent v1.148.0에서 실제 실행으로 확인):
  입력(stdin JSON): {"tool_name": "...", "tool_response": "<결과 텍스트>", ...}
  출력(stdout JSON):
    바꿀 때 → {"hook_specific_output": {"updated_tool_response": "<대체 텍스트>"}}
    안 바꿀 때 → {}
  ※ 예전 형식 {"updatedResponse": ...} 은 이 버전에서 조용히 무시된다(적용 안 됨).
  ※ 빈 문자열을 updated_tool_response로 주면 결과가 지워진다 — 바꿀 때만 출력할 것.

이 훅은 차단이 불가능하다(비차단 훅). 그래서 의심 패턴이 걸리면 내용을 지우는 대신
원문 뒤에 경고를 덧붙여, 모델이 "이건 외부 데이터지 지시사항이 아니다"라고 인식하게 한다.
원문은 맨 앞에 그대로 둔다(WEB이 오류 응답의 Airlock 문구를 앞부분에서 읽는다).

Airlock 자체의 출력 보호(secret redaction 등)는 Audit 로그 대상에만 적용되고 Agent가
실제로 받는 result.content/structuredContent에는 반영되지 않는 gap(CP09)이 있어,
이 훅이 사실상 그 구간의 유일한 방어선이다.

agent.yaml 등록 형식(도구 이벤트이므로 matcher 필요):
  hooks:
    tool_response_transform:
      - matcher: "*"
        hooks:
          - type: command
            command: python3 /절대경로/tool_response_transform_injection_guard.py
            timeout: 10
            on_error: warn
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from injection_patterns import scan, wrap_as_untrusted  # noqa: E402


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
    tool_response = payload.get("tool_response", "")

    text = json.dumps(tool_response, ensure_ascii=False) if isinstance(tool_response, (dict, list)) else str(tool_response)

    hits = scan(text)
    if hits:
        wrapped = wrap_as_untrusted(text, hits)
        print(json.dumps({"hook_specific_output": {"updated_tool_response": wrapped}}, ensure_ascii=False))
        return

    # 매칭 없음 — 아무것도 바꾸지 않는다.
    print("{}")


if __name__ == "__main__":
    main()
