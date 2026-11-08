#!/usr/bin/env python3
"""
tool_response_transform 훅 — 도구 결과의 비밀값 가리기 (10/31 추가)

왜 필요한가
  mcp-portainer 2.45.1은 응답의 환경변수(Env) 값만 [REDACTED]로 가린다(portainer_mcp/redaction.py).
  로그·프로세스 목록(top)·실행 인자(Cmd/Args)·라벨 안의 비밀번호나 토큰은 그대로 모델에 간다.
  팀 보안 정책표 5.4·5.5절의 "출력 보호"를 위해 이 훅이 흔한 비밀값 모양을 [REDACTED]로 바꾼다.

가리는 것(패턴 기반이라 모든 비밀값을 잡지는 못한다)
  - password/passwd/secret/token/api_key/access_key/private_key/auth_token/credential 이름 뒤의 값
    (KEY=값, KEY: 값, "KEY": "값", --key=값, --key 값)
  - Authorization: Bearer/Basic 값, URL 안의 사용자:비밀번호@
  - -----BEGIN ... PRIVATE KEY----- 블록
  - 잘 알려진 토큰 모양(AWS AKIA…, GitHub ghp_…, Slack xox…, OpenAI·OpenRouter sk-…, JWT)

입출력(docker-agent v1.148.0, 기존 인젝션 훅과 같은 형식)
  입력: {"tool_name": "...", "tool_response": "<결과>", ...}
  출력: 바꿀 때 {"hook_specific_output": {"updated_tool_response": "<가린 결과>"}} / 아니면 {}

등록: tool_response_transform, matcher "docker_proxy"와 "StackFileInspect"(11/6), 인젝션 훅보다 앞.
  이 훅 종류는 차단을 못 한다. 훅이 실패하면 원문이 그대로 간다(on_error: warn) — 한계로 기록해 둔다.
표준 라이브러리만 사용.
"""
import json
import re
import sys

MASK = "[REDACTED]"
NAME = r"(?:[A-Za-z0-9_.\-]*?(?:passw(?:or)?d|secret|token|api[_\-]?key|access[_\-]?key|private[_\-]?key|auth[_\-]?token|credentials?|session[_\-]?key)[A-Za-z0-9_.\-]*)"

RULES = [
    # -----BEGIN RSA PRIVATE KEY----- ... -----END ...-----
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(-----END [A-Z ]*PRIVATE KEY-----|$)", re.S), MASK),
    # Authorization: Bearer xxx / Basic xxx
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=\-]{8,}"), r"\1 " + MASK),
    # scheme://user:pass@host
    (re.compile(r"(?i)\b([a-z][a-z0-9+.\-]*://[^\s:/@\"']+):[^\s@/\"']+@"), r"\1:" + MASK + "@"),
    # "NAME": "value"  (JSON 안)
    (re.compile(r'(?i)("' + NAME + r'"\s*:\s*")((?:[^"\\]|\\.)+)(")'), r"\1" + MASK + r"\3"),
    # \"NAME\": \"value\"  (JSON 문자열 안에 한 번 더 들어간 경우)
    (re.compile(r'(?i)(\\"' + NAME + r'\\"\s*:\s*\\")((?:[^"\\]|\\[^"])+)(\\")'), r"\1" + MASK + r"\3"),
    # ["--NAME", "value"]  (Cmd·Args 목록에서 옵션과 값이 따로 있는 경우)
    (re.compile(r'(?i)("-{1,2}' + NAME + r'"\s*,\s*")(?!' + re.escape(MASK) + r')((?:[^"\\]|\\.)+)(")'), r"\1" + MASK + r"\3"),
    # NAME=value, NAME: value, --NAME=value
    (re.compile(r"(?i)((?:^|[\s\"'\[,;{(])-{0,2}" + NAME + r"\s*[=:]\s*)(?![\[{]|" + re.escape(MASK) + r")([^\s\"',;}\]]{3,})"),
     r"\1" + MASK),
    # --NAME value (명령줄 옵션. 일반 문장의 "token expired" 같은 것은 건드리지 않도록 -- 가 있을 때만)
    (re.compile(r"(?i)((?:^|[\s\"'\[,;{(])--?" + NAME + r"\s+)(?!" + re.escape(MASK) + r")([^\s\"',;}\]-][^\s\"',;}\]]{2,})"),
     r"\1" + MASK),
    # 잘 알려진 토큰 모양
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), MASK),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"), MASK),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}\b"), MASK),
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}\b"), MASK),
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b"), MASK),
]


# Docker 로그 스트림의 프레임 머리(8바이트: 종류 1·0 3개·길이 4). 길이 바이트가 아무 글자나 될 수 있어서
# 비밀값 이름 바로 앞에 붙으면 "단어 시작" 검사가 깨진다(11/1 결합 검사에서 DB_PASSWORD를 못 가림). 먼저 떼어 낸다.
DOCKER_FRAME = re.compile(r"[\x00-\x02]\x00\x00\x00[\s\S]{4}")


def mask(text):
    text = DOCKER_FRAME.sub("", text)
    count = 0
    for pat, rep in RULES:
        text, n = pat.subn(rep, text)
        count += n
    return text, count


def mask_stack_file(text):
    """StackFileInspect 결과(11/6). Compose가 JSON 문자열 안에 \\n으로 들어 있어서, 그대로 가리면 값과 함께 줄바꿈까지 지워진다.
    JSON을 풀어 Compose 글자에서 가린 뒤 다시 JSON으로 만든다. JSON이 아니면 그대로 가린다."""
    try:
        doc = json.loads(text)
    except ValueError:
        return mask(text)
    if not isinstance(doc, dict) or not isinstance(doc.get("StackFileContent"), str):
        return mask(text)
    doc["StackFileContent"], count = mask(doc["StackFileContent"])
    return json.dumps(doc, ensure_ascii=False), count


def main():
    raw = sys.stdin.read().strip()
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        payload = {}
    resp = payload.get("tool_response", "")
    text = json.dumps(resp, ensure_ascii=False) if isinstance(resp, (dict, list)) else str(resp)
    if payload.get("tool_name") == "StackFileInspect":
        new, count = mask_stack_file(text)
    else:
        new, count = mask(text)
    if count and new:
        new += f"\n\n[비밀값으로 보이는 값 {count}곳을 {MASK}로 가렸습니다. 실제 값을 추측하지 마세요]"
        print(json.dumps({"hook_specific_output": {"updated_tool_response": new}}, ensure_ascii=False))
        return
    print("{}")


# 이 훅 종류(tool_response_transform)는 결과를 막을 수 없어서, 훅이 오류로 끝나면 가리지 않은 원본이 그대로 간다.
# 그래서 오류가 나면 결과 전체를 안내 문구로 바꾼다(11/1, 안전 쪽). 시간 초과로 강제 종료되는 경우는 여기서 잡지 못한다.
HIDDEN = "[비밀값을 가리는 중 오류가 나서 이 도구 결과를 숨겼습니다. 다시 조회하고, 계속되면 관리자에게 알리세요]"

if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 — 어떤 오류든 결과를 숨긴다(fail-closed)
        print(json.dumps({"hook_specific_output": {"updated_tool_response": HIDDEN}}, ensure_ascii=False))
