#!/usr/bin/env python3
"""
[직접 연결용] tool_input_transform 훅 — 스택(Compose) 도구 검사 (10/31 추가)

왜 필요한가
  새 컨테이너는 docker_proxy의 /containers/create 대신 Portainer 스택으로 만든다
  (팀 보안 정책표 2절·5.7절). 스택 생성 도구는 Compose 파일을 문자열로 받으므로,
  그 안의 위험한 설정(권한 상승, 호스트 폴더·docker.sock 연결, host 네트워크 등)을
  이 훅이 읽어서 "허용 항목만 통과, 나머지는 거부"로 검사한다.
  검사한 내용을 다시 YAML로 써서(updated_input) 보내므로, 검사한 것과 실제 보내는 것이 같다.

대상 도구 (mcp-portainer 2.45.1, PORTAINER_PROFILES=DOCKER에서 확인한 인자)
  StackList                          filters, select            → 그대로 통과(조회)
  StackStart / StackStop             id, endpointId, select     → 둘 다 양의 정수. 11/6부터 Portainer에 물어 실제 스택·환경 확인
  StackCreateDockerStandaloneString  endpointId, Name, StackFileContent, Env, select
                                     (Registries·FromAppTemplate=true·Webhook은 거부)
  StackFileInspect                   id, version, select        → 11/6 추가. 스택 수정 전에 지금 Compose를 읽는다(승인, 결과는 비밀값 가리기)
  StackUpdate                        id, endpointId, StackFileContent, Env, select → 11/6 추가(정책표 5.7)
                                     Prune·PullImage·RepullImageAndRedeploy·RollbackTo·Webhook은 값이 false여도 거부, Registries 거부

Compose 검사(허용 항목만)
  최상위: services(필수), volumes, networks, name, version
  서비스: image(필수, build 금지), command, entrypoint, environment, ports, expose,
          volumes(이름 있는 볼륨만), restart(no·always·unless-stopped·on-failure[:N]),
          depends_on, networks, labels, working_dir, user, hostname, container_name,
          healthcheck, mem_limit, mem_reservation, cpus, stop_signal, stop_grace_period,
          tty, stdin_open, read_only, init, deploy(resources만)
  거부 예: privileged, cap_add, devices, security_opt, sysctls, pid, ipc, network_mode,
          env_file, secrets, configs, extends, include, build, 호스트 경로·docker.sock 마운트,
          Portainer 데이터 볼륨, volumes의 driver_opts, bridge 외 네트워크 드라이버
  비밀번호(11/9, 정책표 5.7·215·238줄): 이름에 password·secret·token·api_key 등이 들어간 환경변수에 값을 적으면 거부,
  값 안의 user:비밀번호@ 주소도 거부. Env 인자도 같다. 예외: MYSQL_RANDOM_ROOT_PASSWORD·MARIADB_RANDOM_ROOT_PASSWORD="yes"
  (앱이 스스로 비밀번호를 만든다. 로그에 나오는 값은 결과 가리기 훅이 가린다). postgres처럼 비밀번호가 꼭 필요한 이미지는 만들 수 없다.
  '$' 변수 치환(${VAR})은 거부한다 — 검사 뒤에 값이 바뀌어 호스트 경로 등이 들어갈 수 있다.
  ('$$'는 글자 '$' 그대로라 허용)

restart·포트·자원(11/1, 정책표 5.7)
  restart: no, unless-stopped, on-failure:1~5만. always와 횟수 없는 on-failure는 거부(무제한 재시작 방지)
  ports: 호스트에 공개하는 포트는 1024~65535만, 9443·8000(Portainer)은 거부. 호스트 포트를 안 적으면 Docker가 임의 번호를 고른다(허용)
  자원: 서비스당 메모리 2GB·CPU 2개까지. 적지 않으면 기본값(mem_limit 512m, cpus 1)으로 채운다

이미지 출처(11/1): Docker Hub 공식 이미지와 image_source.py의 ALLOW 목록만 허용

같은 이름 처리(11/6, 정책표 5.7 "이름 충돌은 DENY". 11/1 수정본 .fix-1101을 portainer_api로 옮김)
  스택을 만들기 전에 Portainer에 물어서, 아래 중 하나라도 겹치면 승인 창을 띄우기 전에 거부한다.
  - 같은 이름의 Portainer 스택(대소문자 무시)
  - 같은 이름의 Compose 프로젝트(라벨 com.docker.compose.project). Portainer 밖에서 만든 것도 포함
  - Compose의 container_name과 같은 이름의 기존 컨테이너, Compose 안에서 container_name이 두 번 쓰인 경우
  조회에 실패하면 거부한다(fail-closed). 훅 env에 AGENT_ENV_FILE 필요

스택 수정(11/6, 정책표 2절·5.7 StackUpdate ASK)
  - 대상 스택을 Portainer에 물어 확인한다: 있어야 하고, endpointId가 실제 소속 환경과 같아야 하고, Compose 스택이어야 한다.
  - 관리 스택(bosun-backup, 이름에 portainer)은 수정·정지하지 않는다(정책표 5절 보호 리소스).
  - Compose(StackFileContent)는 필수이고 생성과 같은 검사를 거친다.
  - 모델이 StackFileInspect 결과의 가려진 값([REDACTED])을 그대로 보내면, 지금 스택의 같은 서비스·같은 환경변수 값으로 되살린다.
    되살릴 값이 없으면 거부한다(가려진 글자가 실제 비밀번호로 들어가는 것을 막음).

입출력: 통과 {} / 인자 보정 {"hook_specific_output": {"updated_input": {...}}} / 거부 {"decision":"block","reason":...}
등록: tool_input_transform, 스택 도구마다 matcher, on_error: block
필요: PyYAML(import yaml). 없으면 스택 생성은 모두 거부된다(fail-closed).
"""
import json
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from image_source import image_allowed, reject_text  # noqa: E402 — 이미지 출처 제한(11/1)
from deny_guide import stack_reason  # noqa: E402 — 거부 안내 ①②③(11/1)
import portainer_api  # noqa: E402 — 같은 이름·수정 대상 확인(11/6)

NAME_RE = r"[a-z0-9][a-z0-9_-]{0,62}"          # Compose 프로젝트 이름 규칙(소문자)
SVC_RE = r"[A-Za-z0-9][A-Za-z0-9_.-]{0,62}"
IMG_RE = r"[A-Za-z0-9][A-Za-z0-9_.\-/:@]*"
PROTECTED = re.compile(r"portainer", re.I)
RESTART_RE = r"no|unless-stopped|on-failure:[1-5]"   # 11/1: always·횟수 없는 on-failure 거부
MEM_RE = r"\d+(\.\d+)?\s*[bkmgBKMG]?[bB]?"
DUR_RE = r"(\d+(\.\d+)?(ns|us|ms|s|m|h))+"
PORT_SHORT_RE = r"((\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):)?(\d{1,5}(-\d{1,5})?:)?\d{1,5}(-\d{1,5})?(/(tcp|udp|sctp))?"

PORT_MIN, PORT_MAX = 1024, 65535
PORTAINER_PORTS = {9443, 8000}
MEM_CAP = 2 * 1024 ** 3        # 서비스당 메모리 상한 2GB
CPU_CAP = 2.0                  # 서비스당 CPU 상한 2개
MEM_DEFAULT, CPU_DEFAULT = "512m", 1   # 11/1: 안 적었을 때 채우는 기본 상한

TOP_KEYS = {"services", "volumes", "networks", "name", "version"}
SVC_KEYS = {"image", "command", "entrypoint", "environment", "ports", "expose", "volumes", "restart",
            "depends_on", "networks", "labels", "working_dir", "user", "hostname", "container_name",
            "healthcheck", "mem_limit", "mem_reservation", "cpus", "stop_signal", "stop_grace_period",
            "tty", "stdin_open", "read_only", "init", "deploy"}
CREATE_KEYS = {"endpointId", "Name", "StackFileContent", "Env", "select", "Registries", "FromAppTemplate", "Webhook"}
UPDATE_KEYS = {"id", "endpointId", "StackFileContent", "Env", "select", "Registries"}
UPDATE_EXTRA = ("Prune", "PullImage", "RepullImageAndRedeploy", "RollbackTo", "Webhook")  # 정책표 5.7: 값이 false여도 거부
MANAGED_STACKS = {"bosun-backup"}   # 관리자가 만든 관리 스택(백업). 수정·정지 금지
COMPOSE_STACK_TYPE = 2              # Portainer 스택 종류: 1 Swarm, 2 Compose, 3 Kubernetes
LOOKUP_TIMEOUT = 5
MASK = "[REDACTED]"
# 11/9 정책표 5.7·238줄: 평문 토큰·패스워드를 Compose·승인 기록에 넣지 않는다. 215줄: Env에도 비밀값 금지.
# 이름 기준은 결과 가리기 훅(tool_response_transform_secret_mask.py NAME)과 같다.
SECRET_NAME = re.compile(r"(?i)(passw(?:or)?d|secret|token|api[_\-]?key|access[_\-]?key|private[_\-]?key|"
                         r"auth[_\-]?token|credentials?|session[_\-]?key)")
URL_CRED = re.compile(r"(?i)[a-z][a-z0-9+.\-]*://[^\s:/@\"']+:[^\s@/\"']+@")
# 앱이 스스로 강한 비밀번호를 만들게 하는 켜기/끄기 설정(비밀값이 아님). 값은 yes/true/1만
SECRET_FLAG_OK = {"MYSQL_RANDOM_ROOT_PASSWORD", "MARIADB_RANDOM_ROOT_PASSWORD"}
FLAG_YES = {"yes", "true", "1"}
ALLOWED_TEXT = ("스택에서 쓸 수 있는 설정: image, command, entrypoint, environment, ports, expose, "
                "이름 있는 volumes, restart, depends_on, networks(bridge), labels, working_dir, user, hostname, "
                "container_name, healthcheck, mem_limit, mem_reservation, cpus, deploy.resources, stop_signal, "
                "stop_grace_period, tty, stdin_open, read_only, init.")


class Reject(Exception):
    pass


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))


def block(reason):
    # 11/1: ① 막힌 것 ② 이유 ③ 대신 할 수 있는 것 형식(deny_guide.py)
    out({"decision": "block", "reason": stack_reason("스택 검사 훅이 이 요청을 거부했습니다.", reason)})


def pos_int(v, where):
    if isinstance(v, bool) or not isinstance(v, int) or v <= 0:
        raise Reject(f"{where}는 1 이상의 정수여야 합니다.")
    return v


def s(v, where, pattern=None):
    if isinstance(v, bool) or not isinstance(v, (str, int, float)):
        raise Reject(f"{where}는 문자열이어야 합니다.")
    v = str(v)
    if re.search(r"[\x00-\x08\x0b-\x1f\x7f]", v):
        raise Reject(f"{where}에 제어문자가 있습니다.")
    if pattern and not re.fullmatch(pattern, v):
        raise Reject(f"{where} 값 '{v[:60]}'의 형식이 허용되지 않습니다.")
    return v


def b(v, where):
    if not isinstance(v, bool):
        raise Reject(f"{where}는 true/false여야 합니다.")
    return v


def only(d, keys, where):
    if not isinstance(d, dict):
        raise Reject(f"{where}는 객체(키: 값)여야 합니다.")
    for k in d:
        if k not in keys:
            raise Reject(f"{where}의 '{k}' 설정은 허용되지 않습니다.")
    return d


def str_or_list(v, where):
    if isinstance(v, list):
        return [s(x, where) for x in v]
    return s(v, where)


def check_volume_ref(src, where):
    src = s(src, where)
    if src.startswith(("/", ".", "~")) or "\\" in src or ":" in src:
        raise Reject(f"{where} '{src[:60]}': 호스트 폴더 연결은 허용되지 않습니다. 이름 있는 볼륨만 쓸 수 있습니다.")
    s(src, where, r"[A-Za-z0-9][A-Za-z0-9_.-]*")
    if PROTECTED.search(src):
        raise Reject(f"{where}: Portainer 데이터 볼륨({src})은 연결할 수 없습니다.")
    return src


def check_service_volumes(vols, where, declared):
    if not isinstance(vols, list):
        raise Reject(f"{where}는 목록이어야 합니다.")
    res = []
    for v in vols:
        if isinstance(v, str):
            parts = v.split(":")
            if len(parts) not in (2, 3):
                raise Reject(f"{where} '{v[:60]}': '볼륨이름:/컨테이너경로[:ro]' 형식만 허용됩니다(익명 볼륨·호스트 폴더 금지).")
            name = check_volume_ref(parts[0], where)
            s(parts[1], f"{where} 컨테이너 경로", r"/[^:]*")
            if len(parts) == 3 and parts[2] not in ("ro", "rw"):
                raise Reject(f"{where} 옵션은 ro 또는 rw만 허용됩니다.")
        else:
            only(v, {"type", "source", "target", "read_only"}, f"{where} 항목")
            if v.get("type") != "volume":
                raise Reject(f"{where}는 type: volume(이름 있는 볼륨)만 허용됩니다. bind·tmpfs 등은 허용되지 않습니다.")
            name = check_volume_ref(v.get("source"), where)
            s(v.get("target"), f"{where} target", r"/[^:]*")
            if "read_only" in v:
                b(v["read_only"], "read_only")
        if name not in declared:
            raise Reject(f"{where}: 볼륨 '{name}'은(는) 최상위 volumes에 선언되어 있어야 합니다.")
        res.append(v)
    return res


def check_host_ports(published, where):
    """호스트에 공개할 포트(범위 가능)가 허용 범위인지 본다."""
    lo, _, hi = str(published).partition("-")
    lo, hi = int(lo), int(hi or lo)
    if lo > hi or lo < PORT_MIN or hi > PORT_MAX:
        raise Reject(f"{where} 호스트 포트 {published}는 {PORT_MIN}~{PORT_MAX} 사이여야 합니다.")
    for pp in PORTAINER_PORTS:
        if lo <= pp <= hi:
            raise Reject(f"{where} 호스트 포트 {pp}는 Portainer가 쓰는 포트라 쓸 수 없습니다.")


def check_ports(ports, where):
    if not isinstance(ports, list):
        raise Reject(f"{where}는 목록이어야 합니다.")
    for p in ports:
        if isinstance(p, dict):
            only(p, {"target", "published", "protocol", "host_ip", "mode", "name"}, f"{where} 항목")
            s(p.get("target"), f"{where} target", r"\d{1,5}")
            if "published" in p:
                check_host_ports(s(p["published"], f"{where} published", r"\d{1,5}(-\d{1,5})?"), where)
            if "protocol" in p:
                s(p["protocol"], f"{where} protocol", r"tcp|udp|sctp")
            if "host_ip" in p:
                s(p["host_ip"], f"{where} host_ip", r"[0-9.]+|[0-9a-fA-F:]+")
            if "mode" in p:
                s(p["mode"], f"{where} mode", r"host|ingress")
            if "name" in p:
                s(p["name"], f"{where} name", SVC_RE)
        else:
            v = s(p, f"{where} 항목", PORT_SHORT_RE)
            m = re.fullmatch(PORT_SHORT_RE, v)
            if m.group(4):  # 호스트 포트를 적은 경우만 검사(없으면 Docker가 임의 번호)
                check_host_ports(m.group(4).rstrip(":"), where)
    return ports


def mem_bytes(v, where):
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([bkmgBKMG]?)[bB]?", str(v).strip())
    if not m:
        raise Reject(f"{where} 값 '{v}'의 형식이 허용되지 않습니다.")
    return float(m.group(1)) * {"": 1, "b": 1, "k": 1024, "m": 1024 ** 2, "g": 1024 ** 3}[m.group(2).lower()]


def cap_mem(v, where):
    if mem_bytes(v, where) > MEM_CAP:
        raise Reject(f"{where} 메모리 {v}는 상한(2GB)을 넘습니다.")


def cap_cpu(v, where):
    if float(v) > CPU_CAP:
        raise Reject(f"{where} CPU {v}는 상한(2개)을 넘습니다.")


def check_deploy(d, where):
    only(d, {"resources"}, where)
    r = only(d.get("resources", {}), {"limits", "reservations"}, f"{where}.resources")
    for k in ("limits", "reservations"):
        if k in r:
            lim = only(r[k], {"cpus", "memory"}, f"{where}.resources.{k}")
            if "cpus" in lim:
                cap_cpu(s(lim["cpus"], "cpus", r"\d+(\.\d+)?"), f"{where}.resources.{k}")
            if "memory" in lim:
                cap_mem(s(lim["memory"], "memory", MEM_RE), f"{where}.resources.{k}")


def check_healthcheck(h, where):
    only(h, {"test", "interval", "timeout", "retries", "start_period", "start_interval", "disable"}, where)
    if "test" in h:
        str_or_list(h["test"], f"{where}.test")
    for k in ("interval", "timeout", "start_period", "start_interval"):
        if k in h:
            s(h[k], f"{where}.{k}", DUR_RE)
    if "retries" in h:
        pos_int(h["retries"], f"{where}.retries")
    if "disable" in h:
        b(h["disable"], f"{where}.disable")


def check_secret_value(key, v, where):
    """11/9: 비밀번호·토큰 같은 값을 그대로 적으면 거부(정책표 238줄). 값이 없으면(키만) 통과."""
    if v is None:
        return
    key, sv = str(key), str(v)
    if key in SECRET_FLAG_OK:
        if sv.strip().lower() not in FLAG_YES:
            raise Reject(f"{where} '{key}'는 \"yes\"만 쓸 수 있습니다.")
        return
    if SECRET_NAME.search(key) and sv != "":
        raise Reject(f"{where} '{key}'에 비밀번호·토큰 값을 직접 적었습니다. 평문 비밀번호는 Compose·Env에 넣을 수 없습니다(정책표 5.7).")
    if key == "POSTGRES_HOST_AUTH_METHOD" and sv.strip().lower() == "trust":
        raise Reject(f"{where} 'POSTGRES_HOST_AUTH_METHOD: trust'는 비밀번호 없이 누구나 DB에 들어오게 합니다. 허용되지 않습니다.")
    if URL_CRED.search(sv):
        raise Reject(f"{where} '{key}' 값의 주소 안에 비밀번호(user:비밀번호@)가 들어 있습니다. 평문 비밀번호는 Compose·Env에 넣을 수 없습니다(정책표 5.7).")


def check_service(name, svc, vol_names, net_names, svc_names):
    where = f"서비스 '{name}'"
    s(name, "서비스 이름", SVC_RE)
    only(svc, SVC_KEYS, where)
    if "image" not in svc:
        raise Reject(f"{where}에 image가 없습니다(build는 허용되지 않습니다).")
    s(svc["image"], f"{where} image", IMG_RE)
    if not image_allowed(str(svc["image"])):
        raise Reject(f"{where}: " + reject_text(str(svc["image"])))
    for k in ("command", "entrypoint"):
        if k in svc and svc[k] is not None:
            str_or_list(svc[k], f"{where} {k}")
    if "environment" in svc:
        env = svc["environment"]
        if isinstance(env, dict):
            for k, v in env.items():
                s(k, f"{where} environment 키", r"[A-Za-z_][A-Za-z0-9_.\-]*")
                if v is not None:
                    s(v, f"{where} environment 값")
                check_secret_value(k, v, f"{where} environment")
        elif isinstance(env, list):
            for e in env:
                s(e, f"{where} environment 항목", r"[A-Za-z_][A-Za-z0-9_.\-]*(=.*)?")
                k, _, v = str(e).partition("=")
                check_secret_value(k, v if "=" in str(e) else None, f"{where} environment")
        else:
            raise Reject(f"{where} environment는 목록이나 객체여야 합니다.")
    if "ports" in svc:
        check_ports(svc["ports"], f"{where} ports")
    if "expose" in svc:
        for p in svc["expose"] if isinstance(svc["expose"], list) else [None]:
            s(p, f"{where} expose", r"\d{1,5}(/(tcp|udp|sctp))?")
    if "volumes" in svc:
        check_service_volumes(svc["volumes"], f"{where} volumes", vol_names)
    if "restart" in svc:
        if svc["restart"] is False:  # YAML에서 따옴표 없이 쓴 no는 False로 읽힌다
            svc["restart"] = "no"
        if not re.fullmatch(RESTART_RE, str(svc["restart"])):
            raise Reject(f"{where} restart '{svc['restart']}'는 허용되지 않습니다. no, unless-stopped, on-failure:1~5 중에서 고르세요"
                         "(always와 횟수 없는 on-failure는 무제한 재시작이라 거부).")
    if "depends_on" in svc:
        deps = svc["depends_on"]
        names = deps if isinstance(deps, list) else list(only(deps, svc_names, f"{where} depends_on"))
        for d in names:
            if d not in svc_names:
                raise Reject(f"{where} depends_on의 '{d}'는 이 스택에 없는 서비스입니다.")
        if isinstance(deps, dict):
            for d, cond in deps.items():
                only(cond or {}, {"condition", "restart", "required"}, f"{where} depends_on.{d}")
    if "networks" in svc:
        nets = svc["networks"]
        names = nets if isinstance(nets, list) else list(nets)
        for n in names:
            if n not in net_names and n != "default":
                raise Reject(f"{where} networks의 '{n}'은(는) 최상위 networks에 선언되어 있어야 합니다.")
        if isinstance(nets, dict):
            for n, cfg in nets.items():
                cfg = only(cfg or {}, {"aliases"}, f"{where} networks.{n}")
                if "aliases" in cfg:
                    for a in cfg["aliases"]:
                        s(a, "aliases", SVC_RE)
    if "labels" in svc:
        lab = svc["labels"]
        for item in (lab.items() if isinstance(lab, dict) else [(x, "") for x in lab]):
            s(item[0], f"{where} labels")
            if item[1] is not None:
                s(item[1], f"{where} labels")
    for k in ("working_dir", "user", "stop_signal"):
        if k in svc:
            s(svc[k], f"{where} {k}")
    for k in ("hostname", "container_name"):
        if k in svc:
            v = s(svc[k], f"{where} {k}", SVC_RE)
            if PROTECTED.search(v):
                raise Reject(f"{where} {k}에 portainer는 쓸 수 없습니다.")
    for k in ("mem_limit", "mem_reservation"):
        if k in svc:
            cap_mem(s(svc[k], f"{where} {k}", MEM_RE), f"{where} {k}")
    if "cpus" in svc:
        cap_cpu(s(svc["cpus"], f"{where} cpus", r"\d+(\.\d+)?"), f"{where} cpus")
    if "stop_grace_period" in svc:
        s(svc["stop_grace_period"], f"{where} stop_grace_period", DUR_RE)
    for k in ("tty", "stdin_open", "read_only", "init"):
        if k in svc:
            b(svc[k], f"{where} {k}")
    if "healthcheck" in svc:
        check_healthcheck(svc["healthcheck"], f"{where} healthcheck")
    if "deploy" in svc:
        check_deploy(svc["deploy"], f"{where} deploy")
    # 상한을 적지 않았으면 기본값으로 채운다(11/1). deploy.resources.limits에 적었으면 그쪽을 쓴다
    limits = ((svc.get("deploy") or {}).get("resources") or {}).get("limits") or {}
    if "mem_limit" not in svc and "memory" not in limits:
        svc["mem_limit"] = MEM_DEFAULT
    if "cpus" not in svc and "cpus" not in limits:
        svc["cpus"] = CPU_DEFAULT


def check_compose(text):
    if not isinstance(text, str) or not text.strip():
        raise Reject("StackFileContent(Compose 내용)가 없습니다.")
    if len(text) > 100_000:
        raise Reject("Compose 내용이 너무 깁니다.")
    if re.search(r"(?<!\$)\$(?!\$)", text.replace("$$", "")):
        raise Reject("Compose에 '$' 변수 치환(${...})은 허용되지 않습니다. 값을 직접 적으세요('$' 글자가 필요하면 '$$').")
    try:
        import yaml
    except ImportError:
        raise Reject("훅 실행 환경에 PyYAML이 없어 Compose를 검사할 수 없습니다(python3 -m pip install pyyaml).")

    class UniqueLoader(yaml.SafeLoader):
        pass

    def no_dup(loader, node, deep=False):
        keys = set()
        for k, _ in node.value:
            key = loader.construct_object(k, deep=deep)
            if key in keys:
                raise Reject(f"Compose에 같은 키 '{key}'가 두 번 있습니다.")
            keys.add(key)
        return loader.construct_mapping(node, deep=deep)

    UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, no_dup)
    try:
        doc = yaml.load(text, Loader=UniqueLoader)
    except Reject:
        raise
    except yaml.YAMLError as e:
        raise Reject("Compose가 올바른 YAML이 아닙니다: " + str(e).splitlines()[0][:120])
    only(doc, TOP_KEYS, "Compose 최상위")
    if "name" in doc:
        s(doc["name"], "Compose name", NAME_RE)

    vols = doc.get("volumes") or {}
    only(vols, set(vols), "최상위 volumes")
    for vname, vcfg in vols.items():
        check_volume_ref(vname, "최상위 volumes 이름")
        vcfg = only(vcfg or {}, {"labels", "name", "external", "driver"}, f"볼륨 '{vname}'")
        if vcfg.get("driver", "local") != "local":
            raise Reject(f"볼륨 '{vname}'의 driver는 local만 허용됩니다.")
        if "name" in vcfg:
            check_volume_ref(vcfg["name"], f"볼륨 '{vname}' name")
        if "external" in vcfg:
            b(vcfg["external"], f"볼륨 '{vname}' external")

    nets = doc.get("networks") or {}
    only(nets, set(nets), "최상위 networks")
    for nname, ncfg in nets.items():
        s(nname, "네트워크 이름", SVC_RE)
        ncfg = only(ncfg or {}, {"driver", "labels", "internal", "name", "external"}, f"네트워크 '{nname}'")
        if ncfg.get("driver", "bridge") != "bridge":
            raise Reject(f"네트워크 '{nname}'의 driver는 bridge만 허용됩니다.")
        for k in ("internal", "external"):
            if k in ncfg:
                b(ncfg[k], f"네트워크 '{nname}' {k}")
        real = ncfg.get("name", nname)
        if str(real).lower() in {"host", "none"} or PROTECTED.search(str(real)):
            raise Reject(f"네트워크 '{real}'는 연결할 수 없습니다.")

    services = doc.get("services")
    if not isinstance(services, dict) or not services:
        raise Reject("Compose에 services가 없습니다.")
    for name, svc in services.items():
        check_service(name, svc, set(vols), set(nets), set(services))
    return yaml.safe_dump(doc, allow_unicode=True, sort_keys=False)


def lookup(path, what):
    """Portainer 조회. 실패하면 거부(fail-closed)."""
    try:
        return portainer_api.get(path, LOOKUP_TIMEOUT)
    except portainer_api.PortainerError as e:
        if e.status == 404:
            raise Reject(f"{what}: 대상을 찾지 못했습니다. 스택 목록(StackList)을 먼저 확인하세요.") from None
        raise Reject(f"{what}을(를) 위한 Portainer 조회에 실패했습니다({e}). 잠시 후 다시 시도하세요.") from None


def check_name_conflicts(endpoint_id, name, compose_text):
    """같은 이름의 스택·Compose 프로젝트·컨테이너가 있으면 거부한다(11/6, 정책표 5.7 이름 충돌 DENY)."""
    import yaml
    wanted = []
    for svc in ((yaml.safe_load(compose_text) or {}).get("services") or {}).values():
        cname = (svc or {}).get("container_name")
        if cname:
            if str(cname) in wanted:
                raise Reject(f"Compose 안에서 container_name '{cname}'이(가) 두 번 쓰였습니다.")
            wanted.append(str(cname))
    for st in lookup("/api/stacks", "같은 이름 확인") or []:
        if str(st.get("Name", "")).lower() == name.lower():
            raise Reject(f"같은 이름의 스택 '{st.get('Name')}'이(가) 이미 있습니다(id {st.get('Id')}).")
    q = urllib.parse.quote(json.dumps({"label": [f"com.docker.compose.project={name}"]}))
    if lookup(f"/api/endpoints/{endpoint_id}/docker/containers/json?all=1&filters={q}", "같은 이름 확인"):
        raise Reject(f"같은 이름의 Compose 프로젝트 '{name}'이(가) 이미 있습니다(Portainer 밖에서 만든 것일 수 있음).")
    if wanted:
        existing = {n.lstrip("/") for c in lookup(f"/api/endpoints/{endpoint_id}/docker/containers/json?all=1", "같은 이름 확인") or []
                    for n in c.get("Names") or []}
        for cname in wanted:
            if cname in existing:
                raise Reject(f"container_name '{cname}'과(와) 같은 이름의 컨테이너가 이미 있습니다.")


def check_stack_target(args, change=True):
    """id·endpointId가 실제 스택과 소속 환경을 가리키는지 확인한다(11/6, 정책표 5.7). 스택 정보를 돌려준다."""
    stack_id = pos_int(args.get("id"), "스택 id")
    endpoint_id = pos_int(args.get("endpointId"), "endpointId")
    st = lookup(f"/api/stacks/{stack_id}", f"스택(id {stack_id}) 확인")
    if st.get("EndpointId") != endpoint_id:
        raise Reject(f"스택(id {stack_id})은 환경 {st.get('EndpointId')}에 있습니다. endpointId {endpoint_id}와 맞지 않습니다.")
    if st.get("Type") != COMPOSE_STACK_TYPE:
        raise Reject(f"스택 '{st.get('Name')}'은(는) Compose 스택이 아니라서 다룰 수 없습니다.")
    sname = str(st.get("Name", ""))
    if change and (sname.lower() in MANAGED_STACKS or PROTECTED.search(sname)):
        raise Reject(f"'{sname}'은(는) 관리용 스택이라 바꾸거나 끌 수 없습니다.")
    return st


def env_values(svc):
    """서비스 environment를 {키: 값}으로. 값 없는 항목은 None."""
    env = (svc or {}).get("environment")
    if isinstance(env, dict):
        return {str(k): v for k, v in env.items()}
    if isinstance(env, list):
        return {str(e).split("=", 1)[0]: (str(e).split("=", 1)[1] if "=" in str(e) else None) for e in env}
    return {}


def is_masked(v):
    # 가린 결과 "KEY: [REDACTED]"를 YAML로 읽으면 목록 ["REDACTED"]가 된다
    return v == MASK or v == ["REDACTED"]


def restore_masked(text, current_text):
    """모델이 되돌려 보낸 [REDACTED]를 지금 스택의 같은 서비스·같은 환경변수 값으로 되살린다(11/6)."""
    if not isinstance(text, str) or "REDACTED" not in text:
        return text
    import yaml
    new = yaml.safe_load(text)
    cur = yaml.safe_load(current_text or "") or {}
    if not isinstance(new, dict):
        return text
    for sname, svc in (new.get("services") or {}).items():
        if not isinstance(svc, dict) or "environment" not in svc:
            continue
        old = env_values((cur.get("services") or {}).get(sname))

        def fix(k, v, sname=sname, old=old):
            if not is_masked(v):
                return v
            ov = old.get(k)
            if ov is None or is_masked(ov):
                raise Reject(f"서비스 '{sname}' environment '{k}'의 값이 가려져({MASK}) 있어 되살릴 수 없습니다. "
                             "새 값을 직접 정해 적으세요.")
            return ov
        env = svc["environment"]
        if isinstance(env, dict):
            svc["environment"] = {k: fix(str(k), v) for k, v in env.items()}
        elif isinstance(env, list):
            svc["environment"] = [f"{str(e).split('=', 1)[0]}={fix(str(e).split('=', 1)[0], str(e).split('=', 1)[1])}"
                                  if "=" in str(e) else e for e in env]
    out_text = yaml.safe_dump(new, allow_unicode=True, sort_keys=False)
    if "REDACTED" in out_text:
        raise Reject(f"Compose에 가려진 값({MASK})이 남아 있습니다. environment가 아닌 곳의 가려진 값은 되살릴 수 없으니 새 값을 적으세요.")
    return out_text


def check_env_arg(args):
    env = args.get("Env") or []
    if not isinstance(env, list):
        raise Reject("Env는 목록이어야 합니다.")
    for e in env:
        only(e, {"name", "value"}, "Env 항목")
        s(e.get("name"), "Env name", r"[A-Za-z_][A-Za-z0-9_]*")
        s(e.get("value", ""), "Env value")
        if is_masked(e.get("value")):
            raise Reject(f"Env '{e.get('name')}'의 값이 가려져({MASK}) 있습니다. 새 값을 직접 적으세요.")
        check_secret_value(e.get("name"), e.get("value", ""), "Env")


def check_update(args):
    for k in args:
        if k in UPDATE_EXTRA:
            raise Reject(f"스택 수정의 '{k}' 옵션은 허용되지 않습니다(값이 false여도 보내지 마세요). Compose 내용만 바꿀 수 있습니다.")
        if k not in UPDATE_KEYS:
            raise Reject(f"'{k}' 인자는 허용되지 않습니다.")
    if args.get("Registries"):
        raise Reject("Registries(사설 레지스트리 지정)는 허용되지 않습니다.")
    if not isinstance(args.get("StackFileContent"), str) or not args["StackFileContent"].strip():
        raise Reject("스택 수정에는 바꾼 뒤의 Compose 전체(StackFileContent)가 필요합니다. StackFileInspect로 지금 내용을 먼저 읽으세요.")
    st = check_stack_target(args)
    check_env_arg(args)
    content = args["StackFileContent"]
    if "REDACTED" in content:
        cur = lookup(f"/api/stacks/{st['Id']}/file", "지금 Compose 읽기").get("StackFileContent", "")
        content = restore_masked(content, cur)
    new = {k: v for k, v in args.items() if k in ("id", "endpointId", "Env") and v not in (None, [])}
    new["select"] = None  # 11/8: 변경 도구에는 select를 쓰지 않는다(잘못되면 실행은 됐는데 오류만 돌아와 다시 보내게 됨)
    new["StackFileContent"] = check_compose(content)
    return new


def check_create(args):
    for k in args:
        if k not in CREATE_KEYS:
            raise Reject(f"'{k}' 인자는 허용되지 않습니다.")
    pos_int(args.get("endpointId"), "endpointId")
    s(args.get("Name"), "스택 이름(Name)", NAME_RE)
    if PROTECTED.search(args["Name"]):
        raise Reject("스택 이름에 portainer는 쓸 수 없습니다.")
    if args.get("Registries"):
        raise Reject("Registries(사설 레지스트리 지정)는 허용되지 않습니다.")
    if args.get("FromAppTemplate"):
        raise Reject("FromAppTemplate=true는 허용되지 않습니다.")
    if args.get("Webhook"):
        raise Reject("Webhook(외부 호출로 재배포)은 허용되지 않습니다.")
    check_env_arg(args)
    new = {k: v for k, v in args.items() if k in ("endpointId", "Name", "Env") and v not in (None, [])}
    new["select"] = None  # 11/8: 변경 도구에는 select를 쓰지 않는다
    new["StackFileContent"] = check_compose(args.get("StackFileContent"))
    check_name_conflicts(args["endpointId"], args["Name"], new["StackFileContent"])
    return new


def main():
    raw = sys.stdin.read().strip()
    payload = json.loads(raw) if raw else {}
    tool = payload.get("tool_name")
    raw_args = payload.get("tool_input") or {}
    # 11/6: 모델은 안 쓰는 선택 인자를 null로 채워 보낸다(실제 실행에서 commitHash: null). null은 "보내지 않음"으로 본다
    args = {k: v for k, v in raw_args.items() if v is not None}
    if tool == "StackList":
        out({})
        return
    if tool in ("StackStart", "StackStop"):
        try:
            for k in args:
                if k not in ("id", "endpointId", "select"):
                    raise Reject(f"'{k}' 인자는 허용되지 않습니다.")
            check_stack_target(args, change=(tool == "StackStop"))  # 11/6: 실제 스택·환경 확인, 관리 스택은 끄지 않음
        except Reject as r:
            block(str(r))
            return
        # 11/8: select는 빼고 보낸다. mcp-portainer는 실행 뒤에 select를 적용해서, 잘못된 select면 켜기·끄기는 됐는데
        #   오류가 돌아와 AI가 같은 요청을 다시 보낸다(11/8 웹 테스트: StackStart 첫 호출 select "{}" → 실제로는 켜짐 → 재요청 409)
        out({"hook_specific_output": {"updated_input": {**args, "select": None}}} if raw_args.get("select") not in (None, "") else {})
        return
    if tool == "StackFileInspect":  # 11/6: 수정 전에 지금 Compose 읽기(승인)
        try:
            for k in args:
                if k not in ("id", "version", "select"):
                    raise Reject(f"'{k}' 인자는 허용되지 않습니다.")
            pos_int(args.get("id"), "스택 id")
            if args.get("version") is not None:
                pos_int(args["version"], "version")
        except Reject as r:
            block(str(r))
            return
        out({"hook_specific_output": {"updated_input": args}} if args != raw_args else {})
        return
    if tool == "StackUpdate":  # 11/6: 정책표 5.7 StackUpdate ASK
        try:
            new = check_update(args)
        except Reject as r:
            block(str(r))
            return
        out({"hook_specific_output": {"updated_input": new}})
        return
    if tool == "StackCreateDockerStandaloneString":
        try:
            new = check_create(args)
        except Reject as r:
            block(str(r))  # 허용 설정 목록은 기본 안내(③)에 들어간다
            return
        out({"hook_specific_output": {"updated_input": new}})
        return
    if isinstance(tool, str) and tool.startswith("Stack"):
        block(f"{tool}은(는) 허용된 스택 도구가 아닙니다.")
        return
    out({})


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — 어떤 오류든 거부(fail-closed)
        block("검사 중 오류: " + str(exc)[:200])
