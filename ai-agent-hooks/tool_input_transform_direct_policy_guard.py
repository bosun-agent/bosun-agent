#!/usr/bin/env python3
"""
[직접 연결용] tool_input_transform 훅 — docker_proxy 허용 목록 정책

왜 필요한가
  permissions의 deny는 path를 글자 그대로 비교한다. 그래서 'arch%69ve'처럼 인코딩하면
  deny를 피하고, 실행 단계에서 풀려 실행된다(WEB 담당 실측). 또 "GET 전체 허용 + 위험한 것만 deny"
  방식은 목록에 없는 위험한 GET(이미지 내보내기 등)을 통과시킨다.
  이 훅은 반대로 "허용 목록에 있는 것만 통과, 나머지는 모두 거부"로 동작한다.

검사 순서
  1) docker_proxy가 아니면 통과.
  2) path 형식 검사: '/'로 시작, 인코딩·우회 문자(%, \\, ?, #, 공백·제어문자), '..', '//' 금지.
     /v1.43 같은 버전 접두어는 떼고 검사한다.
  3) headers가 있으면 거부. body는 컨테이너 생성·네트워크 생성·연결·해제에서만 허용하고 내용을 검사한다.
  4) (method, path)가 아래 허용 목록에 있어야 통과.
       GET    : /_ping /version /info /system/df
                /containers/json  /containers/{id}/json|logs|stats|top
                /images/json      /images/{name}/json|history
                /volumes /volumes/{name}  /networks /networks/{id}
       POST   : /containers/{id}/start|stop|restart
                /images/create       (레지스트리에서 이미지 받기만: fromImage, tag, platform)
       DELETE : /containers/{id}   (뒤의 백업 훅을 거친다)
     [10/31 변경] 컨테이너 생성(/containers/create)은 허용 목록에서 뺐다 → 스택(Compose)으로 만든다
                  (tool_input_transform_stack_guard.py가 검사). 이미지·네트워크 삭제도 뺐다(DENY).
     [11/6 변경] 보안 정책표 3절 DENY에 맞춰 일시정지·재개(pause/unpause), 이미지 검색(/images/search),
                  네트워크 생성·연결·해제(/networks/create, connect, disconnect)를 허용 목록에서 뺐다(10/18에 추가했던 것).
                  검색·네트워크 검사 코드는 되돌릴 때를 위해 남겨 둔다.
  5) (10/31부터 사용 안 함) 컨테이너 생성 설정 검사. 아래 코드는 되돌릴 때를 위해 남겨 둔다.
       허용: Image, Cmd, Entrypoint, Env, Labels, ExposedPorts, WorkingDir, User, Hostname, Tty,
             StopSignal, StopTimeout, HostConfig{PortBindings, RestartPolicy, Memory, MemoryReservation,
             NanoCpus, CpuShares, Binds(이름 있는 볼륨만), Mounts(type=volume만), NetworkMode, AutoRemove,
             ReadonlyRootfs}
       거부 예: Privileged, CapAdd, Devices, SecurityOpt, PidMode/IpcMode/UTSMode/UsernsMode,
             호스트 폴더 마운트(/로 시작하는 Binds, type=bind), docker.sock, NetworkMode=host·container:,
             NetworkingConfig, VolumeOptions, Portainer 데이터 볼륨 마운트
       Docker는 JSON 키를 대소문자 구분 없이 읽으므로 키를 대소문자 무시로 비교하고,
       검사한 내용 그대로 다시 써서(updated_input) 보낸다 → 검사한 것과 실제 보내는 것이 같다.
  6) 컨테이너 DELETE의 force=true는 거부(실행 중이면 정지 → 삭제 두 단계, 각각 승인).
     stats는 stream=false를 자동으로 채운다(무한 대기 방지).
     logs(10/31): follow=true 거부, 허용 키는 follow·tail·stdout·stderr·since·until·timestamps만.
       tail은 1~200 정수. 없으면 100을 채우고, all·0 이하·200 초과는 거부. stdout·stderr가 둘 다 없으면 둘 다 true.
  7) /v1.43 같은 버전 접두어가 있으면 떼어 낸 경로로 바꿔 보낸다(10/31). permissions의 allow 경로와
     같은 모양이 되어야 승인 규칙이 맞게 적용되기 때문이다.
  통과해도 승인 여부는 그 뒤 permissions(strict)가 정한다. 이 훅은 "범위"만 정한다.

입출력
  입력(stdin JSON): {"tool_name": "...", "tool_input": {...}, ...}
  출력: 통과 {} / 인자 보정 {"hook_specific_output": {"updated_input": {...}}} / 거부 {"decision": "block", "reason": "..."}

등록: tool_input_transform, matcher "docker_proxy", 백업 훅보다 앞, on_error: block
표준 라이브러리만 사용.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from image_source import image_allowed, reject_text  # noqa: E402 — 이미지 출처 제한(11/1)
from deny_guide import proxy_reason  # noqa: E402 — 거부 안내 ①②③(11/1)
import portainer_api  # noqa: E402 — 컨테이너를 ID로 고정(11/1)

REQ = {"method": "GET", "path": "", "select": None}  # 거부 안내를 고를 때 쓰는 현재 요청

SEG = r"[A-Za-z0-9][A-Za-z0-9_.\-]*"                 # 컨테이너·네트워크·볼륨 ID/이름
IMG = r"[A-Za-z0-9][A-Za-z0-9_.\-/:@]*"              # 이미지 이름(레지스트리/경로:태그@digest)
TRUE_VALUES = {"1", "true", "yes", "on"}

ALLOW = {
    "GET": [
        r"/_ping", r"/version", r"/info", r"/system/df",
        r"/containers/json", rf"/containers/{SEG}/(json|logs|stats|top)",
        r"/images/json", rf"/images/{IMG}/(json|history)",
        r"/volumes", rf"/volumes/{SEG}",
        r"/networks", rf"/networks/{SEG}",
    ],
    "POST": [rf"/containers/{SEG}/(start|stop|restart)", r"/images/create",   # 11/6: pause·unpause·네트워크 변경 뺌(정책표 DENY)
             rf"/containers/{SEG}/exec", r"/exec/[0-9a-f]{64}/start"],   # 11/2: 백업 명령 예외만(아래 check_backup_exec)
    "DELETE": [rf"/containers/{SEG}"],
}
ALLOW_RE = {m: [re.compile(rf"^{p}$") for p in pats] for m, pats in ALLOW.items()}

ALLOWED_TEXT = ("허용 범위: 조회(목록·상세·로그·사용량·시스템 정보), "
                "컨테이너 시작·정지·재시작, 공식 이미지 받기, 정지된 컨테이너 삭제. 새 앱은 스택(Compose)으로 만들고 고친다")
LOG_KEYS = {"follow", "tail", "stdout", "stderr", "since", "until", "timestamps"}
LOG_TAIL_DEFAULT = "100"
LOG_TAIL_MAX = 200
CREATE_TEXT = ("생성에서 쓸 수 있는 설정: 이미지, 명령, 환경변수, 라벨, 포트, 작업 폴더, 사용자, 재시작 정책, "
               "메모리·CPU 제한, 이름 있는 볼륨 연결, 네트워크(host 제외).")

# 생성 설정 허용 항목(정식 이름). 비교는 대소문자 무시.
CONFIG_KEYS = ["Image", "Cmd", "Entrypoint", "Env", "Labels", "ExposedPorts", "WorkingDir", "User",
               "Hostname", "Tty", "StopSignal", "StopTimeout", "HostConfig"]
HOST_KEYS = ["PortBindings", "RestartPolicy", "Memory", "MemoryReservation", "NanoCpus", "CpuShares",
             "Binds", "Mounts", "NetworkMode", "AutoRemove", "ReadonlyRootfs"]
RESTART_NAMES = {"", "no", "always", "unless-stopped", "on-failure"}
PROTECTED_VOLUME = re.compile(r"portainer", re.I)    # Portainer 데이터(키·설정) 볼륨은 연결 금지
# 11/2 백업 명령 예외: exec는 이 컨테이너의 backup 명령 하나만 허용한다(offen/docker-volume-backup, 관리자가 만든 중앙 백업 스택).
#   1단계 POST /containers/bosun-backup/exec  body {"Cmd": ["backup"], "AttachStdout": true, "AttachStderr": true}  → 승인 필요
#   2단계 POST /exec/{exec ID}/start           body {"Detach": false, "Tty": false}
#         2단계 요청에는 명령이 안 들어 있어서, Portainer에 exec 정보를 다시 물어 "백업 컨테이너의 backup 명령"인지 확인한다.
#   permissions deny는 bosun-backup 말고 모든 컨테이너의 exec를 막도록 적혀 있다(yaml). 그래서 1단계 경로는 ID가 아니라 이름으로 보낸다.
BACKUP_CONTAINER = "bosun-backup"
BACKUP_EXEC_BODY = {"Cmd": ["backup"], "AttachStdout": True, "AttachStderr": True}
BACKUP_START_BODY = {"Detach": False, "Tty": False}
PROTECTED_CONTAINER = re.compile(r"portainer", re.I)  # Portainer 컨테이너 보호. 11/3부터 실제 대상(조회한 이름) 기준이라 ID로 와도 거른다
SEARCH_SELECT = "[*].{name:name,official:is_official,stars:star_count}"  # 설명문(외부 작성 글)은 버린다
# 상세(inspect)는 안전한 필드만 받는다(11/1, 정책표 "inspect 출력: 안전한 필드만"). 모델이 보낸 select는 무시하고 이것으로 바꾼다.
# 뺀 것: 호스트 경로(GraphDriver, LogPath, HostsPath, 볼륨 Mountpoint·마운트 Source), HostConfig 대부분(장치·권한 설정),
#        라벨(비밀값이 들어갈 수 있음. Compose 프로젝트 이름만 남김). Env 값은 mcp-portainer가, 그 밖은 비밀값 가리기 훅이 가린다.
CONTAINER_INSPECT_SELECT = (
    "{id:Id,name:Name,created:Created,state:State.Status,running:State.Running,exitCode:State.ExitCode,"
    "error:State.Error,startedAt:State.StartedAt,finishedAt:State.FinishedAt,health:State.Health.Status,"
    "restartCount:RestartCount,image:Config.Image,cmd:Config.Cmd,entrypoint:Config.Entrypoint,env:Config.Env,"
    "workingDir:Config.WorkingDir,user:Config.User,exposedPorts:Config.ExposedPorts,ports:NetworkSettings.Ports,"
    "networks:NetworkSettings.Networks.*.{ip:IPAddress,aliases:Aliases},restartPolicy:HostConfig.RestartPolicy.Name,"
    "memoryLimit:HostConfig.Memory,nanoCpus:HostConfig.NanoCpus,"
    "mounts:Mounts[].{type:Type,name:Name,destination:Destination,writable:RW},"
    "composeProject:Config.Labels.\"com.docker.compose.project\",composeService:Config.Labels.\"com.docker.compose.service\"}")
IMAGE_INSPECT_SELECT = ("{id:Id,tags:RepoTags,created:Created,size:Size,os:Os,architecture:Architecture,"
                        "exposedPorts:Config.ExposedPorts,cmd:Config.Cmd,entrypoint:Config.Entrypoint,"
                        "workingDir:Config.WorkingDir,user:Config.User,volumes:Config.Volumes}")
VOLUME_INSPECT_SELECT = "{name:Name,driver:Driver,created:CreatedAt,scope:Scope}"
# 11/6 정책표 3절: 시스템 정보는 호스트명·보안 구성·레지스트리 설정 제외, 네트워크는 내부 IP·설정 제외, 이미지 이력은 CreatedBy(빌드 명령) 제외
INFO_SELECT = ("{serverVersion:ServerVersion,os:OperatingSystem,osType:OSType,architecture:Architecture,cpus:NCPU,"
               "memTotal:MemTotal,containers:Containers,running:ContainersRunning,paused:ContainersPaused,"
               "stopped:ContainersStopped,images:Images,storageDriver:Driver}")
NETWORK_LIST_SELECT = "[].{id:Id,name:Name,driver:Driver,scope:Scope,internal:Internal,created:Created}"
NETWORK_INSPECT_SELECT = ("{id:Id,name:Name,driver:Driver,scope:Scope,internal:Internal,created:Created,"
                          "containers:Containers.*.Name}")
IMAGE_HISTORY_SELECT = "[].{created:Created,size:Size,tags:Tags}"
SEARCH_LIMIT_MAX = 25


class Reject(Exception):
    pass


def out(obj):
    # 11/8: 변경 요청(GET 아님)에는 select를 쓰지 않는다. mcp-portainer는 요청을 실행한 뒤에 응답에 select를 적용하므로,
    #   select가 잘못되면 작업은 이미 실행됐는데 오류만 돌아와 AI가 "실패"로 알고 같은 변경을 다시 보낸다(11/8 웹 테스트에서 StackStart 2번).
    if REQ["method"] != "GET" and REQ["select"] not in (None, "") and obj.get("decision") != "block":
        hso = obj.setdefault("hook_specific_output", {})
        hso.setdefault("updated_input", {})["select"] = None
    print(json.dumps(obj, ensure_ascii=False))


def block(reason):
    # 11/1: ① 막힌 것 ② 이유 ③ 대신 할 수 있는 것 형식(deny_guide.py). 예전의 허용 범위 문구는 ③에 들어간다
    out({"decision": "block", "reason": proxy_reason("정책 훅이 이 요청을 거부했습니다.", reason, REQ["method"], REQ["path"])})


def is_empty(v):
    return v is None or v == "" or v == {} or v == []


def canon(obj, allowed, where):
    """dict 키를 대소문자 무시로 허용 목록과 맞추고 정식 이름으로 바꾼 새 dict를 돌려준다."""
    if not isinstance(obj, dict):
        raise Reject(f"{where}는 객체여야 합니다.")
    lower = {k.lower(): k for k in allowed}
    res = {}
    for k, v in obj.items():
        name = lower.get(str(k).lower())
        if name is None:
            raise Reject(f"{where}의 '{k}' 설정은 허용되지 않습니다.")
        if name in res:
            raise Reject(f"{where}에 '{name}' 설정이 중복되었습니다.")
        res[name] = v
    return res


def need_str(v, where, pattern=None):
    if not isinstance(v, str):
        raise Reject(f"{where}는 문자열이어야 합니다.")
    if re.search(r"[\x00-\x1f\x7f]", v):
        raise Reject(f"{where}에 제어문자가 있습니다.")
    if pattern and not re.fullmatch(pattern, v):
        raise Reject(f"{where} 값 '{v[:60]}'의 형식이 허용되지 않습니다.")
    return v


def need_int(v, where):
    if isinstance(v, bool) or not isinstance(v, int) or v < 0:
        raise Reject(f"{where}는 0 이상의 정수여야 합니다.")
    return v


def need_bool(v, where):
    if not isinstance(v, bool):
        raise Reject(f"{where}는 true/false여야 합니다.")
    return v


def str_list(v, where, allow_str=False):
    if allow_str and isinstance(v, str):
        return need_str(v, where)
    if not isinstance(v, list):
        raise Reject(f"{where}는 문자열 목록이어야 합니다.")
    return [need_str(x, where) for x in v]


def volume_name(name, where):
    need_str(name, where, SEG)
    if PROTECTED_VOLUME.search(name):
        raise Reject(f"{where}: Portainer 데이터 볼륨({name})은 연결할 수 없습니다.")
    return name


PORT_KEY = r"\d{1,5}(/(tcp|udp|sctp))?"


def check_host(hc):
    hc = canon(hc, HOST_KEYS, "HostConfig")
    for k in ("Memory", "MemoryReservation", "NanoCpus", "CpuShares"):
        if k in hc:
            need_int(hc[k], k)
    for k in ("AutoRemove", "ReadonlyRootfs"):
        if k in hc:
            need_bool(hc[k], k)
    if "RestartPolicy" in hc:
        rp = canon(hc["RestartPolicy"], ["Name", "MaximumRetryCount"], "RestartPolicy")
        if rp.get("Name", "") not in RESTART_NAMES:
            raise Reject("RestartPolicy.Name은 no, always, unless-stopped, on-failure 중 하나여야 합니다.")
        if "MaximumRetryCount" in rp:
            need_int(rp["MaximumRetryCount"], "MaximumRetryCount")
        hc["RestartPolicy"] = rp
    if "PortBindings" in hc:
        pb = hc["PortBindings"]
        if not isinstance(pb, dict):
            raise Reject("PortBindings는 객체여야 합니다.")
        new = {}
        for port, binds in pb.items():
            need_str(port, "PortBindings 포트", PORT_KEY)
            if binds is None:
                binds = []
            if not isinstance(binds, list):
                raise Reject("PortBindings 값은 목록이어야 합니다.")
            nb = []
            for b in binds:
                b = canon(b, ["HostIp", "HostPort"], "PortBindings 항목")
                if "HostIp" in b:
                    need_str(b["HostIp"], "HostIp", r"|[0-9.]+|[0-9a-fA-F:]+")
                if "HostPort" in b:
                    need_str(b["HostPort"], "HostPort", r"|\d{1,5}")
                nb.append(b)
            new[port] = nb
        hc["PortBindings"] = new
    if "NetworkMode" in hc:
        nm = need_str(hc["NetworkMode"], "NetworkMode", SEG)
        if nm.lower() == "host":
            raise Reject("NetworkMode=host(호스트 네트워크 공유)는 허용되지 않습니다.")
        hc["NetworkMode"] = nm
    if "Binds" in hc:
        binds = str_list(hc["Binds"], "Binds")
        for b in binds:
            parts = b.split(":")
            if len(parts) not in (2, 3) or parts[0].startswith(("/", ".", "~")) or "\\" in b:
                raise Reject(f"Binds '{b[:60]}': 호스트 폴더 연결은 허용되지 않습니다. 이름 있는 볼륨만 '볼륨이름:/컨테이너경로[:ro]' 형식으로 쓸 수 있습니다.")
            volume_name(parts[0], "Binds 볼륨")
            need_str(parts[1], "Binds 컨테이너 경로", r"/[^:]*")
            if len(parts) == 3 and parts[2] not in ("ro", "rw"):
                raise Reject("Binds 옵션은 ro 또는 rw만 허용됩니다.")
        hc["Binds"] = binds
    if "Mounts" in hc:
        if not isinstance(hc["Mounts"], list):
            raise Reject("Mounts는 목록이어야 합니다.")
        mounts = []
        for m in hc["Mounts"]:
            m = canon(m, ["Type", "Source", "Target", "ReadOnly"], "Mounts 항목")
            if m.get("Type") != "volume":
                raise Reject("Mounts는 type=volume(이름 있는 볼륨)만 허용됩니다. 호스트 폴더(bind)·tmpfs 등은 허용되지 않습니다.")
            volume_name(m.get("Source"), "Mounts 볼륨")
            need_str(m.get("Target"), "Mounts Target", r"/[^:]*")
            if "ReadOnly" in m:
                need_bool(m["ReadOnly"], "ReadOnly")
            mounts.append(m)
        hc["Mounts"] = mounts
    return hc


def check_create_body(body):
    cfg = canon(load_body(body, "컨테이너 생성"), CONFIG_KEYS, "생성 설정")
    if "Image" not in cfg:
        raise Reject("생성 설정에 Image가 없습니다.")
    need_str(cfg["Image"], "Image", IMG)
    for k in ("Cmd", "Entrypoint"):
        if k in cfg and cfg[k] is not None:
            cfg[k] = str_list(cfg[k], k, allow_str=True)
    if "Env" in cfg:
        cfg["Env"] = str_list(cfg["Env"], "Env")
        for e in cfg["Env"]:
            need_str(e, "Env 항목", r"[A-Za-z_][A-Za-z0-9_.\-]*=.*")
    if "Labels" in cfg:
        if not isinstance(cfg["Labels"], dict):
            raise Reject("Labels는 객체여야 합니다.")
        for k, v in cfg["Labels"].items():
            need_str(k, "Labels 키")
            need_str(v, "Labels 값")
    if "ExposedPorts" in cfg:
        ep = cfg["ExposedPorts"]
        if not isinstance(ep, dict):
            raise Reject("ExposedPorts는 객체여야 합니다.")
        for p, v in ep.items():
            need_str(p, "ExposedPorts 포트", PORT_KEY)
            if v not in ({}, None):
                raise Reject("ExposedPorts 값은 {}여야 합니다.")
        cfg["ExposedPorts"] = {p: {} for p in ep}
    for k in ("WorkingDir", "User", "Hostname", "StopSignal"):
        if k in cfg:
            need_str(cfg[k], k)
    if "Tty" in cfg:
        need_bool(cfg["Tty"], "Tty")
    if "StopTimeout" in cfg:
        need_int(cfg["StopTimeout"], "StopTimeout")
    if "HostConfig" in cfg:
        cfg["HostConfig"] = check_host(cfg["HostConfig"])
    return cfg


def load_body(body, where):
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            raise Reject(f"{where} body가 올바른 JSON이 아닙니다.")
    return body


def check_network_create_body(body):
    if is_empty(body):
        raise Reject('네트워크 생성 body(설정)가 없습니다. body에 JSON 객체로 이름을 넣으세요. 예: {"Name": "app-net"}')
    cfg = canon(load_body(body, "네트워크 생성"), ["Name", "Driver", "Labels", "Internal"], "네트워크 생성 설정")
    if "Name" not in cfg:
        raise Reject("네트워크 생성 설정에 Name이 없습니다.")
    need_str(cfg["Name"], "네트워크 이름", SEG)
    if cfg["Name"].lower() in {"host", "none", "bridge"}:
        raise Reject(f"'{cfg['Name']}'은(는) Docker 기본 네트워크 이름이라 쓸 수 없습니다.")
    if cfg.get("Driver", "bridge") != "bridge":
        raise Reject("네트워크 드라이버는 bridge만 허용됩니다(macvlan·ipvlan·overlay 등은 호스트 LAN이나 다른 노드에 연결됩니다).")
    cfg["Driver"] = "bridge"
    if "Labels" in cfg:
        if not isinstance(cfg["Labels"], dict):
            raise Reject("Labels는 객체여야 합니다.")
        for k, v in cfg["Labels"].items():
            need_str(k, "Labels 키")
            need_str(v, "Labels 값")
    if "Internal" in cfg:
        need_bool(cfg["Internal"], "Internal")
    return cfg


def check_network_attach_body(body, action):
    if is_empty(body):
        raise Reject(f'네트워크 {action} body(설정)가 없습니다. body에 JSON 객체로 컨테이너를 넣으세요. 예: {{"Container": "web"}}')
    allowed = ["Container", "EndpointConfig"] if action == "connect" else ["Container"]
    cfg = canon(load_body(body, "네트워크 " + action), allowed, "네트워크 " + action + " 설정")
    if "Container" not in cfg:
        raise Reject("Container(대상 컨테이너)가 없습니다.")
    need_str(cfg["Container"], "Container", SEG)
    if PROTECTED_CONTAINER.search(cfg["Container"]):
        raise Reject("Portainer 컨테이너의 네트워크는 바꿀 수 없습니다.")
    if "EndpointConfig" in cfg:
        ec = canon(cfg["EndpointConfig"], ["Aliases"], "EndpointConfig")
        if "Aliases" in ec:
            ec["Aliases"] = [need_str(a, "Aliases 항목", SEG) for a in str_list(ec["Aliases"], "Aliases")]
        cfg["EndpointConfig"] = ec
    return cfg


def check_logs_query(query):
    """logs 조회 인자 검사(10/31). 고친 query를 돌려준다."""
    for k in query:
        if k not in LOG_KEYS:
            raise Reject(f"로그 조회의 query_params '{k}'는 허용되지 않습니다(follow, tail, stdout, stderr, since, until, timestamps만).")
    q = {k: str(v).strip() for k, v in query.items()}
    if q.get("follow", "false").lower() not in {"", "0", "false"}:
        raise Reject("logs의 follow=true는 응답이 끝나지 않아 허용되지 않습니다. tail을 지정하세요.")
    q["follow"] = "false"
    tail = q.get("tail", "") or LOG_TAIL_DEFAULT
    if not re.fullmatch(r"\d{1,6}", tail) or not 1 <= int(tail) <= LOG_TAIL_MAX:
        raise Reject(f"logs의 tail은 1~{LOG_TAIL_MAX} 사이 정수여야 합니다(all이나 그보다 큰 값은 허용되지 않습니다).")
    q["tail"] = str(int(tail))
    for k in ("stdout", "stderr", "timestamps"):
        if k in q:
            low = q[k].lower()
            if low not in {"0", "1", "true", "false"}:
                raise Reject(f"logs의 {k}는 true/false여야 합니다.")
            q[k] = "true" if low in {"1", "true"} else "false"
    if "stdout" not in q and "stderr" not in q:
        q["stdout"] = q["stderr"] = "true"
    if q.get("stdout") == "false" and q.get("stderr", "false") == "false":
        raise Reject("logs의 stdout과 stderr가 둘 다 false면 볼 수 있는 로그가 없습니다.")
    for k in ("since", "until"):
        if k in q and not re.fullmatch(r"\d{1,12}", q[k]):
            raise Reject(f"logs의 {k}는 0 이상의 UNIX 시각(초)이어야 합니다.")
    if "since" in q and "until" in q and int(q["since"]) > int(q["until"]) > 0:
        raise Reject("logs의 since가 until보다 늦습니다.")
    return q


def _body_dict(body):
    if isinstance(body, str):
        body = json.loads(body) if body.strip() else {}
    return body if isinstance(body, dict) else {}


def check_backup_exec_body(body, cname):
    """exec 1단계: 백업 컨테이너의 backup 명령만. 고친 body를 돌려준다."""
    if cname != BACKUP_CONTAINER:
        raise Reject(f"컨테이너 안 명령 실행(exec)은 백업 컨테이너('{BACKUP_CONTAINER}')의 backup 명령만 허용됩니다('{cname}'은 대상이 아님).")
    b = _body_dict(body)
    if not b:  # 11/2: 허용되는 명령이 하나뿐이라, 모델이 body를 비워 보내면 정해진 명령으로 채운다(실제 실행에서 모델이 null로 보냄)
        return dict(BACKUP_EXEC_BODY)
    for k in b:
        if k not in BACKUP_EXEC_BODY:
            raise Reject(f"백업 실행 요청의 body '{k}'는 허용되지 않습니다(Cmd, AttachStdout, AttachStderr만).")
    if b.get("Cmd") != ["backup"]:
        raise Reject("백업 컨테이너에서는 Cmd [\"backup\"] 하나만 실행할 수 있습니다.")
    for k in ("AttachStdout", "AttachStderr"):
        if k in b and not isinstance(b[k], bool):
            raise Reject(f"{k}는 true/false여야 합니다.")
    return dict(BACKUP_EXEC_BODY)


def check_backup_exec_start(env_id, exec_id, body):
    """exec 2단계: Portainer에 exec 정보를 물어 백업 컨테이너의 backup 명령인지 확인한다."""
    if isinstance(env_id, bool) or not str(env_id).isdigit():
        raise Reject("environment_id(환경 번호)가 없거나 숫자가 아닙니다.")
    b = _body_dict(body)
    for k, v in b.items():
        if k not in BACKUP_START_BODY or v is not False:
            raise Reject("백업 실행 시작 요청의 body는 {\"Detach\": false, \"Tty\": false}만 허용됩니다.")
    try:
        info = portainer_api.get(f"/api/endpoints/{env_id}/docker/exec/{exec_id}/json")
        backup_id, _ = portainer_api.container(env_id, BACKUP_CONTAINER)
    except portainer_api.PortainerError as e:
        raise Reject(f"실행하려는 명령이 백업 명령인지 확인하지 못했습니다({e}).") from None
    pc = info.get("ProcessConfig") or {}
    if info.get("ContainerID") != backup_id or pc.get("entrypoint") != "backup" or pc.get("arguments") or pc.get("privileged") \
            or pc.get("user") not in (None, ""):
        raise Reject("이 실행 번호는 백업 컨테이너의 backup 명령이 아니어서 실행할 수 없습니다.")
    if info.get("Running") or info.get("Pid"):
        raise Reject("이 백업 실행은 이미 진행 중이거나 끝났습니다. 다시 하려면 새로 요청하세요.")
    return dict(BACKUP_START_BODY)


def main():
    raw = sys.stdin.read().strip()
    payload = json.loads(raw) if raw else {}
    if payload.get("tool_name") != "docker_proxy":
        out({})
        return
    args = payload.get("tool_input") or {}
    method = str(args.get("method") or "GET").upper()
    path = args.get("path")
    REQ["method"], REQ["path"] = method, path if isinstance(path, str) else ""
    REQ["select"] = args.get("select")

    if not isinstance(path, str) or not path.startswith("/"):
        block("path가 없거나 '/'로 시작하지 않습니다.")
        return
    if re.search(r"[%\\?#\s\x00-\x1f\x7f]", path) or "//" in path or re.search(r"(^|/)\.\.?(/|$)", path):
        block("path에 허용되지 않는 문자나 형식(인코딩 %, \\, ?, #, 공백, '..', '//')이 있습니다. 경로는 원래 글자 그대로 쓰고 쿼리는 query_params로 넘기세요.")
        return
    clean = re.sub(r"^/v\d+(\.\d+)?(?=/)", "", path)
    updates = {"path": clean} if clean != path else {}   # 버전 접두어를 뗀 경로로 보낸다(7)

    if not is_empty(args.get("headers")):
        block("headers는 허용되지 않습니다.")
        return

    if method == "POST" and clean == "/containers/create":
        block("컨테이너 직접 생성은 허용되지 않습니다. 새 컨테이너는 스택(StackCreateDockerStandaloneString)으로 Compose를 보내 만드세요.")
        return
    if method == "DELETE" and re.match(r"^/(images|networks)/", clean):
        block("이미지·네트워크 삭제는 이 Agent에서 허용되지 않습니다.")
        return
    # 11/6: 보안 정책표 3절 DENY(10/18에 열었던 것). 허용 목록에서도 뺐지만 알기 쉬운 이유로 먼저 막는다
    if method == "POST" and re.fullmatch(rf"/containers/{SEG}/(pause|unpause)", clean):
        block("컨테이너 일시정지·재개는 이 Agent에서 허용되지 않습니다.")
        return
    if method == "GET" and clean == "/images/search":
        block("이미지 검색은 이 Agent에서 허용되지 않습니다.")
        return
    if method == "POST" and re.fullmatch(rf"/networks/(create|{SEG}/(connect|disconnect))", clean):
        block("네트워크 생성·연결·해제는 이 Agent에서 허용되지 않습니다.")
        return

    patterns = ALLOW_RE.get(method)
    if not patterns or not any(p.match(clean) for p in patterns):
        block(f"{method} {clean} 은(는) 허용 목록에 없습니다.")
        return

    # 11/1: 컨테이너 대상 요청은 Portainer에 물어 실제 대상을 찾고, 경로를 그 컨테이너의 전체 ID로 바꿔 보낸다.
    #   이름이 헷갈리거나 승인과 실행 사이에 이름이 바뀌어도, 승인한 바로 그 컨테이너에만 실행된다.
    #   ID로 확인하므로 Portainer 컨테이너는 이름이 아니라 실제 대상 기준으로 보호한다(끄기·지우기 등 변경 금지).
    m_c = re.fullmatch(rf"/containers/({SEG})(/[a-z]+)?", clean)
    if m_c and not (m_c.group(1) == "json" and not m_c.group(2)):
        ref, op = m_c.group(1), m_c.group(2) or ""
        env_id = args.get("environment_id")
        if isinstance(env_id, bool) or not str(env_id).isdigit():
            block("environment_id(환경 번호)가 없거나 숫자가 아닙니다.")
            return
        try:
            full_id, cname = portainer_api.container(env_id, ref)
        except portainer_api.PortainerError as e:
            block(f"'{ref}'라는 컨테이너가 없습니다." if e.status == 404 else f"대상 컨테이너를 확인하지 못했습니다({e}).")
            return
        if op == "/exec":
            try:
                body = check_backup_exec_body(args.get("body"), cname)
            except Reject as r:
                block(str(r))
                return
            out({"hook_specific_output": {"updated_input": {"path": f"/containers/{BACKUP_CONTAINER}/exec", "body": body}}})
            return
        if PROTECTED_CONTAINER.search(cname) and method != "GET":
            block(f"관리 도구 컨테이너('{cname}')는 끄거나 지우거나 바꿀 수 없습니다.")
            return
        if clean != f"/containers/{full_id}{op}":
            clean = f"/containers/{full_id}{op}"
            updates["path"] = clean

    m_x = re.fullmatch(r"/exec/([0-9a-f]{64})/start", clean)
    if m_x:
        try:
            body = check_backup_exec_start(args.get("environment_id"), m_x.group(1), args.get("body"))
        except Reject as r:
            block(str(r))
            return
        out({"hook_specific_output": {"updated_input": {**updates, "body": body}}})
        return

    query = args.get("query_params")
    if isinstance(query, str):
        query = json.loads(query) if query.strip() else {}
    query = dict(query) if isinstance(query, dict) else {}
    is_create = method == "POST" and clean == "/containers/create"
    net_m = re.match(rf"^/networks/({SEG})/(connect|disconnect)$", clean) if method == "POST" else None
    is_net_create = method == "POST" and clean == "/networks/create"

    if not (is_create or is_net_create or net_m) and not is_empty(args.get("body")):
        block("body가 필요한 작업은 컨테이너 생성, 네트워크 생성·연결·해제 외에는 허용되지 않습니다.")
        return

    if is_net_create or net_m:
        if query:
            block("네트워크 생성·연결·해제에는 query_params를 쓰지 않습니다.")
            return
        try:
            cfg = check_network_create_body(args.get("body")) if is_net_create else \
                check_network_attach_body(args.get("body"), net_m.group(2))
            if net_m:  # 11/3: 연결·해제할 컨테이너를 실제로 조회해 Portainer면 거부하고, 전체 ID로 고정한다(이름·ID 어느 쪽으로 와도)
                env_id = args.get("environment_id")
                if isinstance(env_id, bool) or not str(env_id).isdigit():
                    raise Reject("environment_id(환경 번호)가 없거나 숫자가 아닙니다.")
                try:
                    full_id, cname = portainer_api.container(env_id, cfg["Container"])
                except portainer_api.PortainerError as e:
                    raise Reject(f"'{cfg['Container']}'라는 컨테이너가 없습니다." if e.status == 404
                                 else f"대상 컨테이너를 확인하지 못했습니다({e}).") from None
                if PROTECTED_CONTAINER.search(cname):
                    raise Reject(f"관리 도구 컨테이너('{cname}')의 네트워크는 바꿀 수 없습니다.")
                cfg["Container"] = full_id
        except Reject as r:
            block(str(r))
            return
        out({"hook_specific_output": {"updated_input": {**updates, "body": cfg}}})
        return

    if method == "GET" and clean == "/images/search":
        for k in query:
            if k not in ("term", "limit"):
                block(f"이미지 검색의 query_params '{k}'는 허용되지 않습니다(term, limit만).")
                return
        try:
            need_str(str(query.get("term", "")), "검색어(term)", r"[A-Za-z0-9][A-Za-z0-9_.\-/]*")
            limit = int(query.get("limit", SEARCH_LIMIT_MAX))
        except (Reject, ValueError) as r:
            block(str(r) if isinstance(r, Reject) else "limit은 숫자여야 합니다.")
            return
        query["limit"] = str(min(max(limit, 1), SEARCH_LIMIT_MAX))
        out({"hook_specific_output": {"updated_input": {**updates, "query_params": query, "select": SEARCH_SELECT}}})
        return


    if is_create:
        for k in query:
            if k not in ("name", "platform"):
                block(f"컨테이너 생성의 query_params '{k}'는 허용되지 않습니다(name, platform만).")
                return
        if "name" in query:
            try:
                need_str(str(query["name"]), "컨테이너 이름", r"/?[A-Za-z0-9][A-Za-z0-9_.\-]+")
            except Reject as r:
                block(str(r))
                return
        if is_empty(args.get("body")):
            block("컨테이너 생성 body(설정)가 없습니다.")
            return
        try:
            cfg = check_create_body(args.get("body"))
        except Reject as r:
            block(str(r) + " " + CREATE_TEXT)
            return
        out({"hook_specific_output": {"updated_input": {"body": cfg, "query_params": query}}})
        return

    if method == "POST" and clean == "/images/create":
        for k in query:
            if k not in ("fromImage", "tag", "platform"):
                block(f"이미지 받기의 query_params '{k}'는 허용되지 않습니다(fromImage, tag, platform만). 파일·URL에서 가져오기는 허용되지 않습니다.")
                return
        try:
            need_str(str(query.get("fromImage", "")), "fromImage", IMG)
            if not image_allowed(str(query["fromImage"])):  # 이미지 출처 제한(11/1), 스택과 같은 규칙
                raise Reject(reject_text(str(query["fromImage"])))
            if "tag" in query:
                need_str(str(query["tag"]), "tag", r"[A-Za-z0-9_][A-Za-z0-9_.\-]*")
        except Reject as r:
            block(str(r))
            return
        out({"hook_specific_output": {"updated_input": updates}} if updates else {})
        return

    if method == "DELETE" and clean.startswith("/containers/") and str(query.get("force", "")).strip().lower() in TRUE_VALUES:
        block("force=true(실행 중인 컨테이너를 강제로 멈추고 삭제)는 허용되지 않습니다. 실행 중이면 먼저 정지한 뒤 삭제하세요(각각 승인 필요).")
        return
    if method == "GET" and clean.endswith("/logs"):
        try:
            query = check_logs_query(query)
        except Reject as r:
            block(str(r))
            return
        updates["query_params"] = query
    if method == "GET":  # 상세(inspect)는 안전한 필드만(11/1)
        for pat, sel in ((rf"/containers/{SEG}/json", CONTAINER_INSPECT_SELECT), (rf"/images/{IMG}/json", IMAGE_INSPECT_SELECT),
                         (rf"/volumes/{SEG}", VOLUME_INSPECT_SELECT), (r"/info", INFO_SELECT),  # 11/6: 아래 셋 추가
                         (r"/networks", NETWORK_LIST_SELECT), (rf"/networks/{SEG}", NETWORK_INSPECT_SELECT),
                         (rf"/images/{IMG}/history", IMAGE_HISTORY_SELECT)):
            if re.fullmatch(pat, clean) and clean != "/containers/json" and clean != "/images/json":
                updates["select"] = sel
    if method == "GET" and clean.endswith("/stats") and str(query.get("stream", "")).strip().lower() not in {"0", "false"}:
        query["stream"] = "false"
        updates["query_params"] = query
    out({"hook_specific_output": {"updated_input": updates}} if updates else {})


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — 어떤 오류든 거부(fail-closed)
        block("정책 검사 중 오류: " + str(exc)[:200])
