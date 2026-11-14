#!/usr/bin/env python3
"""
tool_guard 훅 — 사용자 정책 읽기 (11/15 추가, 웹 담당 요청: "훅이 사용자 선택을 읽게")

왜 필요한가
  웹의 정책 보드에서 사용자가 작업을 허용·묻기·막기 칸으로 옮긴다. 지금까지는 웹이 Agent 설정 파일의
  permissions만 고쳐 썼고, 훅은 그 선택을 몰랐다. 이 훅은 사용자 선택을 직접 읽어 Agent가 지키게 한다.

어떻게 정하나 (더 엄격하게만)
  - deny  : 호출을 막는다(permission_decision "deny"). 정책표가 허용한 작업도 사용자가 막을 수 있다.
  - ask   : 승인을 받게 한다(permission_decision "ask"). 허용 목록에 있어도 승인 카드가 뜬다.
  - allow : 아무것도 하지 않는다. 정책표·훅이 막은 작업은 사용자가 allow로 옮겨도 그대로 막힌다
            (tool_guard의 allow는 참고용이라 다른 규칙을 풀지 못한다 — docker-agent pkg/hooks).
  - 여러 규칙이 맞으면 가장 엄격한 것(deny > ask)을 쓴다.

파일 형식 (BOSUN_USER_POLICY 환경변수에 파일 경로)
  {
    "version": 1,
    "tools": {
      "StackDelete": "deny",
      "backup_volume": "ask",
      "docker_proxy:method=GET:path=/containers/*/logs": "ask"
    }
  }
  - 키는 도구 이름(StackDelete, backup_volume …) 또는 docker_proxy 작업 패턴(Agent 설정 permissions와 같은 글자).
  - 패턴의 *는 / 를 넘어 아무 글자나 맞춘다(넓게 맞춰서 더 엄격한 쪽).
  - docker_proxy 경로는 버전 접두어(/v1.43)를 떼고 비교한다.

파일이 없거나 깨졌을 때
  - 환경변수가 없거나, 파일이 없거나, JSON이 깨졌거나, 값이 allow/ask/deny가 아니면 그 부분은 무시하고
    지금 동작(정책표·permissions·다른 훅) 그대로 둔다. 깨진 경우는 stderr에 한 줄 남긴다.
  - tool_guard는 훅 오류면 호출을 거부하므로 모든 오류를 잡아 {}를 돌려준다.

입출력
  입력(stdin JSON): {"tool_name": "...", "tool_input": {...}, ...}
  출력: {"hook_specific_output": {"permission_decision": "deny"|"ask", "permission_decision_reason": "..."}} / 해당 없음 {}

등록: hooks.tool_guard, matcher "*", 승인 카드 설명 훅 다음
"""
import fnmatch
import json
import os
import re
import sys

LEVEL = {"allow": 0, "ask": 1, "deny": 2}
VERSION_PREFIX = re.compile(r"^/v\d+(\.\d+)?(?=/)")


def load_rules(path):
    """사용자 정책 파일을 읽는다. 문제가 있으면 빈 규칙(지금 동작 유지)."""
    if not path or not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        print(f"[user_policy] 정책 파일을 읽지 못해 무시합니다: {e}", file=sys.stderr)
        return {}
    rules = (data.get("tools") or data.get("rules")) if isinstance(data, dict) else None  # rules는 예전 이름(같은 뜻)
    if not isinstance(rules, dict):
        print("[user_policy] tools가 없어 무시합니다", file=sys.stderr)
        return {}
    return {k: v for k, v in rules.items() if isinstance(k, str) and k and v in LEVEL}


def call_names(tool, args):
    """이 호출을 가리키는 이름들. docker_proxy는 작업 패턴도 만든다."""
    names = [tool]
    if tool == "docker_proxy" and isinstance(args, dict):
        method = str(args.get("method") or "GET").upper()
        path = VERSION_PREFIX.sub("", str(args.get("path") or ""))
        names.append(f"docker_proxy:method={method}:path={path}")
    return names


def decide(tool, args, rules):
    """가장 엄격한 사용자 선택과 맞은 규칙. 해당 없으면 (None, None)."""
    best, key = None, None
    for name in call_names(tool, args):
        for pattern, bucket in rules.items():
            if fnmatch.fnmatchcase(name, pattern) and (best is None or LEVEL[bucket] > LEVEL[best]):
                best, key = bucket, pattern
    return best, key


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        tool = payload.get("tool_name") or ""
        bucket, key = decide(tool, payload.get("tool_input") or {}, load_rules(os.environ.get("BOSUN_USER_POLICY", "")))
    except Exception:  # noqa: BLE001 — tool_guard는 오류면 호출을 거부하므로 지금 동작을 유지한다
        bucket = None
    if bucket == "deny":
        print(json.dumps({"hook_specific_output": {
            "permission_decision": "deny",
            "permission_decision_reason": f"사용자 정책에서 막은 작업입니다({key}). 설정 > 정책에서 바꿀 수 있습니다."}},
            ensure_ascii=False))
    elif bucket == "ask":
        print(json.dumps({"hook_specific_output": {
            "permission_decision": "ask",
            "permission_decision_reason": f"사용자 정책에서 승인을 받도록 정한 작업입니다({key})."}},
            ensure_ascii=False))
    else:
        print("{}")


if __name__ == "__main__":
    main()
