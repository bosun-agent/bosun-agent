#!/usr/bin/env python3
"""
tool_response_transform 훅 — "지금 백업" 실행 (11/2 백업 명령 예외)

왜 필요한가
  Docker의 exec는 1단계(exec 만들기)와 2단계(exec 시작)로 나뉜다. 실제 실행(11/2)에서 모델은 1단계만 계속 반복하고
  2단계로 넘어가지 못해 docker-agent 반복 감지에 걸렸다. 그래서 2단계는 모델에게 맡기지 않고 이 훅이 한다.

하는 일
  docker_proxy POST /containers/bosun-backup/exec(정책 훅이 backup 명령만 통과시키고, 사용자가 승인한 요청)의 결과에서
  exec ID를 꺼내, Portainer에 그 exec가 정말 bosun-backup의 backup 명령인지 다시 확인한 뒤 바로 시작하고,
  도구 결과를 "백업 결과(로그와 종료 코드)"로 바꿔 모델에게 돌려준다.
  이 훅은 사용자가 승인한 1단계가 실제로 실행된 뒤에만 불린다(tool_response_transform은 도구 실행 후에 돈다).

실패하면
  이 훅 종류는 결과를 막지 못한다. 확인·시작에 실패하면 실패 이유를 결과로 돌려준다(백업은 실행되지 않음).
  훅이 시간 초과로 끊겨도 백업 프로세스는 컨테이너 안에서 계속될 수 있다 → 안내 문구에 적는다.

등록: tool_response_transform, matcher "docker_proxy", 비밀값 가리기 훅보다 앞(백업 로그도 가려지게). timeout 300
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import portainer_api  # noqa: E402

BACKUP_CONTAINER = "bosun-backup"   # 정책 훅의 BACKUP_CONTAINER와 같아야 한다
RUN_TIMEOUT = 280                   # yaml의 훅 timeout(300초)보다 짧게
DOCKER_FRAME = re.compile(r"[\x00-\x02]\x00\x00\x00[\s\S]{4}")


def out_text(text):
    print(json.dumps({"hook_specific_output": {"updated_tool_response": text}}, ensure_ascii=False))


def exec_id_from(resp):
    if isinstance(resp, (dict, list)):
        resp = json.dumps(resp)
    m = re.search(r"\b([0-9a-f]{64})\b", str(resp))
    return m.group(1) if m else None


def run(payload):
    if payload.get("tool_name") != "docker_proxy":
        return None
    a = payload.get("tool_input") or {}
    path = re.sub(r"^/v\d+(\.\d+)?", "", str(a.get("path") or ""))
    if str(a.get("method") or "").upper() != "POST" or path != f"/containers/{BACKUP_CONTAINER}/exec":
        return None
    env_id = a.get("environment_id")
    exec_id = exec_id_from(payload.get("tool_response"))
    if not exec_id:  # 준비가 거부됐거나 실패한 결과(거부 이유 등)는 그대로 둔다(11/2 실행에서 거부 이유를 덮어쓰는 문제 수정)
        return None
    if isinstance(env_id, bool) or not str(env_id).isdigit():
        return "백업을 시작하지 못했습니다: environment_id가 없습니다. 백업은 실행되지 않았습니다."
    try:
        info = portainer_api.get(f"/api/endpoints/{env_id}/docker/exec/{exec_id}/json")
        backup_id, _ = portainer_api.container(env_id, BACKUP_CONTAINER)
    except portainer_api.PortainerError as e:
        return f"백업을 시작하지 못했습니다: 실행 번호를 확인하지 못했습니다({e}). 백업은 실행되지 않았습니다."
    pc = info.get("ProcessConfig") or {}
    if info.get("ContainerID") != backup_id or pc.get("entrypoint") != "backup" or pc.get("arguments") \
            or pc.get("privileged") or pc.get("user") not in (None, ""):
        return "백업을 시작하지 못했습니다: 이 실행 번호는 백업 컨테이너의 backup 명령이 아닙니다. 백업은 실행되지 않았습니다."
    if info.get("Running") or info.get("ExitCode") is not None and info.get("Pid"):
        return "이 백업은 이미 실행 중이거나 끝났습니다. 다시 하려면 새로 \"지금 백업해줘\"라고 요청하세요."
    try:
        raw = portainer_api.post_raw(f"/api/endpoints/{env_id}/docker/exec/{exec_id}/start", {"Detach": False, "Tty": False},
                                     RUN_TIMEOUT)
    except portainer_api.PortainerError as e:
        return (f"백업 실행 중 연결이 끊겼습니다({e}). 백업은 컨테이너 안에서 계속 진행 중일 수 있으니, "
                "잠시 뒤 bosun-backup 컨테이너 로그로 결과를 확인하세요. 같은 백업을 바로 다시 요청하지 마세요.")
    log = DOCKER_FRAME.sub("", raw.decode("utf-8", "replace")).strip()
    try:
        code = portainer_api.get(f"/api/endpoints/{env_id}/docker/exec/{exec_id}/json").get("ExitCode")
    except portainer_api.PortainerError:
        code = None
    lines = log.splitlines()[-40:]
    head = ("백업을 마쳤습니다." if code == 0 else
            f"백업이 실패했습니다(종료 코드 {code})." if code not in (None, 0) else "백업 명령이 끝났습니다(종료 코드 확인 불가).")
    return (head + " 백업 파일은 bosun_backups 볼륨에 저장되고 7일이 지나면 자동으로 지워집니다. 아래는 백업 로그(최근 40줄)입니다.\n"
            + "\n".join(lines))


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        text = run(payload)
    except Exception as exc:  # noqa: BLE001 — 결과를 막지 못하는 훅이라, 오류 내용을 결과로 돌려준다
        text = f"백업을 시작하지 못했습니다: 훅 오류({str(exc)[:200]}). 백업은 실행되지 않았을 수 있습니다."
    if text is None:
        print("{}")
    else:
        out_text(text)


if __name__ == "__main__":
    main()
