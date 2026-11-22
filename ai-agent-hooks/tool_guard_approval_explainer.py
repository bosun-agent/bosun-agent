#!/usr/bin/env python3
"""
tool_guard 훅 — 승인 카드 설명 (11/1 추가)

왜 필요한가
  승인 카드에는 "POST /containers/3f2a…/stop" 같은 요청 원문만 보여서 초보자는 무엇을 승인하는지 알기 어렵다.
  모델이 쓴 설명(context.reason)은 모델이 지어낼 수 있어 승인 근거로 쓰지 않기로 했다(WEB 문서 8.2).
  이 훅은 모델과 상관없이, 실제로 실행될 요청(입력 검사 훅을 거친 최종 인자)만 보고 정해진 문장으로 설명을 만든다.

어떻게 전달되나 (docker-agent v1.148.0, 실행으로 확인)
  tool_guard 훅이 hook_specific_output.metadata를 돌려주면 serve api의 tool_call_confirmation 이벤트에
  "metadata": {"reason": "...", "blast_radius": "...", "category": "...", "safety_label": "..."}로 붙는다.
  WEB 승인 카드는 metadata.reason(설명)과 metadata.blast_radius(영향: low·medium·high)를 보여 주면 된다.

판정은 하지 않는다
  permission_decision을 돌려주지 않으므로 허용·거부·승인 여부는 기존 규칙(permissions, 다른 훅) 그대로다.
  tool_guard는 훅이 오류로 끝나면 호출을 거부하므로(공식 문서), 어떤 오류든 잡아서 설명 없이 {}를 돌려준다.

입출력
  입력(stdin JSON): {"tool_name": "...", "tool_input": {...}, ...}
  출력: {"hook_specific_output": {"metadata": {"reason": ..., "blast_radius": ..., "category": ...}}} / 설명할 수 없으면 {}
이름 표시(11/1)
  모델은 ID로 요청하는 경우가 많아서, Portainer에 물어 "'이름' 컨테이너(짧은 ID)", "'이름' 스택(id N)"으로 보여 준다.
  조회는 3초 안에 끝나지 않거나 실패하면 ID만 보여 준다(설명 때문에 요청이 막히지 않게). AGENT_ENV_FILE env 필요

등록: hooks.tool_guard, matcher "*", timeout 10
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import portainer_api  # noqa: E402 — ID를 이름으로 바꿔 보여 주기(11/1)

LOOKUP_TIMEOUT = 3  # 이름 조회가 느리거나 실패하면 ID만 보여 준다


def container_label(env_id, ref):
    """"'이름' 컨테이너(짧은 ID)". 조회가 안 되면 "'ID' 컨테이너"."""
    try:
        full_id, name = portainer_api.container(env_id, ref, LOOKUP_TIMEOUT)
        return f"'{name}' 컨테이너({full_id[:12]})" if name else f"'{short(ref)}' 컨테이너"
    except Exception:  # noqa: BLE001
        return f"'{short(ref)}' 컨테이너"


def stack_label(stack_id):
    try:
        name = portainer_api.stack_name(stack_id, LOOKUP_TIMEOUT)
        return f"'{name}' 스택(id {stack_id})" if name else f"스택(id {stack_id})"
    except Exception:  # noqa: BLE001
        return f"스택(id {stack_id})"


def short(v, n=12):
    """컨테이너 ID 같은 긴 값은 앞부분만 보여 준다."""
    v = str(v)
    return v[:n] if re.fullmatch(r"[0-9a-f]{20,}", v) else v


def explain_proxy(a):
    method = str(a.get("method") or "GET").upper()
    path = re.sub(r"^/v\d+(\.\d+)?", "", str(a.get("path") or ""))
    q = a.get("query_params") or {}
    body = a.get("body") or {}
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except ValueError:
            body = {}

    m = re.fullmatch(r"/containers/([^/]+)(/[a-z]+)?", path)
    if m:
        c, op = container_label(a.get("environment_id"), m.group(1)), m.group(2) or ""
        table = {
            ("GET", "/json"): (f"{c}의 상세 설정을 봅니다. 비밀번호 같은 값은 가려서 보여 줍니다.", "low", "container-inspect"),
            ("GET", "/logs"): (f"{c}의 최근 로그 {q.get('tail', '100')}줄을 봅니다. 비밀번호 같은 값은 가려서 보여 줍니다.", "low", "container-logs"),
            ("GET", "/top"): (f"{c} 안에서 실행 중인 프로그램 목록을 봅니다.", "low", "container-top"),
            ("POST", "/start"): (f"멈춰 있는 {c}를 켭니다.", "low", "container-start"),
            ("POST", "/stop"): (f"{c}를 끕니다. 그 안에서 돌던 서비스가 멈춥니다.", "medium", "container-stop"),
            ("POST", "/restart"): (f"{c}를 껐다가 다시 켭니다. 잠깐 서비스가 끊깁니다.", "medium", "container-restart"),
            ("POST", "/pause"): (f"{c}를 일시정지합니다. 상태는 그대로 두고 동작만 멈춥니다.", "medium", "container-pause"),
            ("POST", "/unpause"): (f"일시정지한 {c}를 다시 움직이게 합니다.", "low", "container-unpause"),
            ("DELETE", ""): (f"멈춰 있는 {c}를 삭제합니다. 삭제 전 설정은 백업되지만, 컨테이너 안에만 있던 파일은 되돌릴 수 없습니다.", "high", "container-delete"),
        }
        if (method, op) == ("DELETE", "") and str(q.get("v", "")).lower() == "true":   # 11/13 v=true
            return (f"멈춰 있는 {c}와 그 컨테이너의 이름 없는 볼륨까지 삭제합니다. 볼륨은 삭제 직전 백업을 확인했지만, "
                    "되살리려면 관리자가 백업에서 복원해야 합니다.", "high", "container-delete-volumes")
        if (method, op) in table:
            return table[(method, op)]

    m = re.fullmatch(r"/images/(.+)/(json|history)", path)
    if method == "GET" and m:
        what = "상세 정보" if m.group(2) == "json" else "만들어진 과정(이력)"
        return (f"'{m.group(1)}' 이미지의 {what}를 봅니다.", "low", "image-inspect")
    if method == "POST" and path == "/images/create":
        img = str(q.get("fromImage", ""))
        tag = q.get("tag")
        ref = f"{img}:{tag}" if tag and ":" not in img.split("/")[-1] else img
        return (f"'{ref}' 이미지를 Docker Hub에서 내려받습니다. 디스크 공간을 씁니다.", "low", "image-pull")
    m = re.fullmatch(r"/volumes/([^/]+)", path)
    if method == "GET" and m:
        return (f"'{m.group(1)}' 볼륨의 상세 정보를 봅니다.", "low", "volume-inspect")
    if method == "DELETE" and m:  # 11/13 정책표 수정본 5.11
        return (f"'{m.group(1)}' 볼륨(앱 데이터)을 영구히 삭제합니다. 삭제 직전 백업을 확인했지만, 되살리려면 관리자가 백업에서 복원해야 합니다.",
                "high", "volume-delete")
    m = re.fullmatch(r"/networks/([^/]+)", path)
    if method == "DELETE" and m:  # 11/13 정책표 수정본 5.12
        # 11/22: 경로 값은 64자리 ID일 때가 많다. 이름은 카드 제목·대상에 나오므로 문장에는 넣지 않는다.
        return (f"이 네트워크를 삭제합니다. 연결된 컨테이너는 없습니다. 이 네트워크를 쓰도록 설정된 앱은 다시 켤 때 영향을 받을 수 있습니다.",
                "medium", "network-delete")
    if method == "POST" and path == "/networks/create":
        name = body.get("Name") or body.get("name") or ""
        return (f"새 네트워크 '{name}'(bridge 방식)을 만듭니다. 이 네트워크에 연결한 컨테이너끼리 이름으로 통신할 수 있게 됩니다.", "low", "network-create")
    m = re.fullmatch(r"/networks/([^/]+)/(connect|disconnect)", path)
    if method == "POST" and m:
        c = container_label(a.get("environment_id"), body.get("Container") or body.get("container") or "")
        if m.group(2) == "connect":
            return (f"{c}를 '{m.group(1)}' 네트워크에 연결합니다.", "low", "network-connect")
        return (f"{c}를 '{m.group(1)}' 네트워크에서 뺍니다. 그 네트워크로 하던 통신이 끊깁니다.", "medium", "network-disconnect")
    return (f"Docker 요청 {method} {path} 실행", "unknown", "docker-other")


def explain_stack_create(a):
    import yaml
    name = a.get("Name", "")
    doc = yaml.safe_load(a.get("StackFileContent") or "") or {}
    parts = []
    for sname, svc in (doc.get("services") or {}).items():
        svc = svc or {}
        bits = [str(svc.get("image", "?"))]
        ports = [str(p) if not isinstance(p, dict) else f"{p.get('published', '')}:{p.get('target', '')}" for p in svc.get("ports") or []]
        if ports:
            bits.append("공개 포트 " + ", ".join(p.replace(":", "→", 1) if ":" in p else f"임의→{p}" for p in ports))
        res = []
        if svc.get("mem_limit"):
            res.append(f"메모리 {svc['mem_limit']}")
        if svc.get("cpus") is not None:
            res.append(f"CPU {svc['cpus']}")
        if res:
            bits.append("·".join(res))
        parts.append(f"{sname}({', '.join(bits)})")
    text = f"새 앱(스택) '{name}'을(를) 만들고 바로 실행합니다. 서비스 {len(parts)}개: " + "; ".join(parts) + "."
    vols = list((doc.get("volumes") or {}).keys())
    if vols:
        text += f" 데이터를 남기는 볼륨: {', '.join(vols)}."
    return (text, "medium", "stack-create")


def explain_stack_update(a):
    """수정 전후 Compose에서 바뀐 줄만 보여 준다(11/6, 정책표 5.7 "수정 전후 정의 및 영향 범위"). 비밀값은 가린다."""
    import difflib
    from tool_response_transform_secret_mask import mask
    label = stack_label(a.get("id"))
    head = f"{label}의 설정(Compose)을 바꾸고 다시 배포합니다. 바뀐 서비스의 컨테이너가 다시 만들어져 잠깐 멈춥니다."
    try:
        cur = portainer_api.get(f"/api/stacks/{int(a.get('id'))}/file", LOOKUP_TIMEOUT).get("StackFileContent", "")
    except Exception:  # noqa: BLE001
        return (head + " (지금 설정을 읽지 못해 바뀌는 부분은 표시하지 못했습니다. 요청 원문을 확인하세요.)", "high", "stack-update")
    import yaml
    before = yaml.safe_dump(yaml.safe_load(cur) or {}, allow_unicode=True, sort_keys=False).splitlines()
    after = (a.get("StackFileContent") or "").splitlines()
    lines = [l for l in difflib.unified_diff(before, after, lineterm="", n=0) if l[:1] in "+-" and l[:3] not in ("+++", "---")]
    if not lines:
        return (head.replace("바꾸고 다시 배포합니다. 바뀐 서비스의 컨테이너가 다시 만들어져 잠깐 멈춥니다.",
                             "그대로 다시 배포합니다(바뀌는 줄 없음)."), "medium", "stack-update")
    shown = [("삭제 " if l[0] == "-" else "추가 ") + l[1:].strip() for l in lines[:12]]
    more = f" 외 {len(lines) - 12}줄" if len(lines) > 12 else ""
    text = head + " 바뀌는 줄: " + " / ".join(shown) + more + "."
    return (mask(text)[0], "high", "stack-update")


def explain(tool, a):
    if tool == "docker_proxy":
        return explain_proxy(a)
    if tool == "StackCreateDockerStandaloneString":
        return explain_stack_create(a)
    if tool == "StackUpdate":
        return explain_stack_update(a)
    if tool == "StackFileInspect":
        return (f"{stack_label(a.get('id'))}의 설정 파일(Compose) 내용을 봅니다. 바꾸는 것은 없고, 비밀값은 가려서 보여 줍니다.",
                "low", "stack-file")
    if tool == "backup_volume":  # 11/12 soteria(볼륨 단위). 웹 백업 카드는 category "backup-now"로 구분한다(웹 담당 11/11 요청)
        import soteria_common as sc
        vol = str(a.get("volume") or a.get("source") or "?").replace("/backup/", "").strip("/")
        try:
            app = sc.all_volumes().get(vol)
        except (OSError, ValueError):
            app = None
        est = sc.estimate_text([vol]) if app else ""
        owner = f"'{app}' 앱의 " if app else ""
        return (f"{owner}데이터 볼륨 '{vol}'을(를) 지금 백업합니다. 지우거나 바꾸는 것은 없습니다. {est} "
                "백업하는 동안 그 앱은 꺼져 있어야 합니다. 끝나면 파일 이름과 지문(sha256)을 확인해 알려 드립니다.", "low", "backup-now")
    if tool == "backup_status":
        return (f"백업 작업 '{a.get('job_id')}'의 결과를 조회합니다. 바꾸는 것은 없습니다.", "low", "backup-status")
    if tool == "StackDelete":  # 11/13 정책표 수정본 5.10
        if a.get("removeVolumes") is True:
            return (f"{stack_label(a.get('id'))}를 데이터(볼륨)까지 모두 삭제합니다. 볼륨은 삭제 직전 백업을 확인했지만, "
                    "되살리려면 관리자가 백업에서 복원해야 합니다.", "high", "stack-delete-volumes")
        return (f"{stack_label(a.get('id'))}를 삭제합니다(컨테이너·네트워크). 데이터(볼륨)는 남겨 둡니다.", "high", "stack-delete")
    if tool == "StackStart":
        return (f"{stack_label(a.get('id'))}에 속한 컨테이너를 모두 켭니다.", "low", "stack-start")
    if tool == "StackStop":
        return (f"{stack_label(a.get('id'))}에 속한 컨테이너를 모두 끕니다. 그 앱의 서비스가 멈춥니다.", "medium", "stack-stop")
    return None


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        r = explain(payload.get("tool_name"), payload.get("tool_input") or {})
    except Exception:  # noqa: BLE001 — tool_guard는 오류면 호출을 거부하므로, 설명만 빼고 넘어간다
        r = None
    if not r:
        print("{}")
        return
    reason, radius, category = r
    print(json.dumps({"hook_specific_output": {"metadata": {"reason": reason, "blast_radius": radius, "category": category}}},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
