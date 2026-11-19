"""soteria(승인 트리거 백업 API + MCP) 공용 모듈 (11/12 정식 결합, 볼륨 단위)

백업 단위는 볼륨(11/12 시원 님 결정 "볼륨 방식 유지"). 창구 컨테이너(관리 스택 bosun-soteria)에 앱 볼륨을
/backup/<볼륨 이름>으로 읽기 전용 연결하고, backup_volume(source=/backup/<볼륨 이름>) 한 번에 볼륨 하나를 한 파일로 묶는다.
목록은 앱별로 묶어 둔다(앱 이름으로 요청받았을 때 볼륨 찾기, 스택 수정 전 그 앱 볼륨 전부의 백업 확인).

백업 대상 목록(SOTERIA_TARGETS_FILE, JSON {"앱": ["볼륨", ...]})은 sync_targets()가 Portainer에서 찾아 만들고,
바뀌면 창구 스택의 Compose를 다시 써서 다시 배포한다(새 앱 볼륨 자동 추가). 관리자가 손으로 넣지 않는다.

훅 env (정식 설정 agent.yaml에서 넣는다)
  SOTERIA_TARGETS_FILE  백업 대상 목록 파일(JSON). 없으면 SOTERIA_TARGETS("앱=볼륨,볼륨;앱=볼륨") — 테스트용
  SOTERIA_ENDPOINT_ID   Portainer 환경 ID
  SOTERIA_RECORD        성공한 백업 기록 파일(JSON 줄). 스택 수정 전 "최근 백업" 확인에 쓴다
  SOTERIA_STACK         창구 스택 이름(기본 bosun-soteria)
  SOTERIA_IMAGE         창구 이미지(기본 soteria:test — 팀원 저장소에서 docker build로 만든 것)
  SOTERIA_PORT          창구를 호스트에 여는 포트(기본 18090, 127.0.0.1에만 연다)
  SOTERIA_API           (11/15) 훅이 창구에 붙는 주소. 기본 http://127.0.0.1:<SOTERIA_PORT>(맥·PC 직접 실행).
                        컨테이너 설치판은 http://bosun-soteria:8080처럼 같은 네트워크 이름으로 준다. 환경변수 → AGENT_ENV_FILE 순으로 찾는다
  SOTERIA_NETWORK       (11/15) 창구를 붙일 도커 네트워크(컨테이너 설치판). 주면 그 네트워크에 별칭 bosun-soteria로 붙인다(환경변수 → agent.env)
  SOTERIA_ARCHIVE_VOLUME 백업 파일 볼륨(기본 bosun_soteria_backups)
  SOTERIA_MAX_AGE_MIN   스택 수정 전 백업이 몇 분 안이어야 하는지(기본 30)
  SOTERIA_HEALTH_WAIT   창구를 다시 배포한 뒤 켜질 때까지 기다리는 최대 초(기본 30)
"""
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import portainer_api  # noqa: E402

APP_RE = re.compile(r"[a-z0-9][a-z0-9_.-]{0,62}")
VOL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,254}")
JOB_RE = re.compile(r"bosun-[a-z0-9_.-]{1,40}-\d{8}T\d{6}-[0-9a-f]{6}")


def job_label(vol):
    """작업 번호에 넣을 짧은 이름(볼륨 이름을 소문자·40자 이내로)."""
    # 11/15: soteria fix 브랜치는 job_id에 ".."이 있으면 400으로 거부한다 → 점 여러 개는 하나로
    return (re.sub(r"\.{2,}", ".", re.sub(r"[^a-z0-9_.-]", "-", vol.lower())).strip("-.") or "vol")[:40]
BYTES_PER_SEC = 60 * 1024 * 1024   # 11/9 시험: 1GB(압축 안 되는 자료) 약 17초 → 보수적으로 초당 60MB
# 백업 대상에서 빼는 관리용 스택·볼륨(창구 자신, 정시 백업, Portainer)
MANAGED_STACKS = {"bosun-backup", "bosun-soteria"}
PROTECTED = re.compile(r"portainer", re.I)
# 11/19: 설치판 자신(Compose 이름 bosun. bosun_data 볼륨에 agent.env의 API 키가 있다)도 백업 대상에서 뺀다.
#   MANAGED_STACKS는 "백업 컨테이너" 판별(is_backup_container)에도 쓰여서 여기에 넣으면 bosun 컨테이너가 백업 컨테이너로
#   취급된다(볼륨 삭제 검사에서 쓰는 컨테이너가 없는 것처럼 보임). 그래서 따로 둔다. 설치판 이름을 바꾸면 BOSUN_SELF_STACKS로 준다.
SELF_STACKS_DEFAULT = "bosun"
# docker-agent가 도구를 실행하지 않았을 때 돌려주는 결과 문구(웹 server/translate.ts와 같은 기준, v1.145.0 pkg/runtime/toolexec)
NOT_RUN = re.compile(r"^(The user rejected the tool call\.|The tool call was rejected by a \w+ hook\.|Tool '[^']+' is denied by )")


def setting(name, default=""):
    return os.environ.get(name) or default


def excluded_stacks():
    """백업 대상에서 빼는 앱 이름: 관리 스택 + 설치판 자신(11/19)."""
    own = {s.strip() for s in setting("BOSUN_SELF_STACKS", SELF_STACKS_DEFAULT).split(",") if s.strip()}
    return MANAGED_STACKS | own


def tool_not_run(text):
    """도구가 실행되지 않은 결과(사용자 거부, 훅 거부, 권한 설정 거부)인지(11/19)."""
    return bool(NOT_RUN.match(str(text or "").lstrip()))


def env_or_file(name):
    """환경변수, 없으면 agent.env(AGENT_ENV_FILE)의 값(11/15). 훅은 --env-from-file 값을 직접 받지 못한다."""
    value = os.environ.get(name, "").strip()
    if not value:
        try:
            value = portainer_api._read_env_file(os.environ.get("AGENT_ENV_FILE", "")).get(name, "").strip()
        except OSError:
            value = ""
    return value


def api_base():
    """창구 주소(11/15). 환경변수 SOTERIA_API → agent.env의 SOTERIA_API → http://127.0.0.1:<SOTERIA_PORT>."""
    url = env_or_file("SOTERIA_API")
    if not re.fullmatch(r"https?://[A-Za-z0-9_.\-\[\]:]+/?", url or ""):
        url = f"http://127.0.0.1:{setting('SOTERIA_PORT', '18090')}"
    return url.rstrip("/")


def endpoint():
    return int(setting("SOTERIA_ENDPOINT_ID", "0") or 0)


def stack_name():
    return setting("SOTERIA_STACK", "bosun-soteria")


# ---------- 백업 대상 목록 ----------

def _clean(t):
    out = {}
    for app, vols in (t or {}).items():
        if not isinstance(app, str) or not APP_RE.fullmatch(app) or app in excluded_stacks() or PROTECTED.search(app):
            continue
        vs = sorted({v for v in (vols or []) if isinstance(v, str) and VOL_RE.fullmatch(v) and not PROTECTED.search(v)})
        if vs:
            out[app] = vs
    return out


def targets():
    """{앱: [볼륨...]}. 파일을 못 읽으면 OSError/ValueError(호출한 쪽이 거부로 처리)."""
    path = setting("SOTERIA_TARGETS_FILE")
    if path:
        if not os.path.exists(path):
            return {}
        with open(path, encoding="utf-8") as f:
            return _clean(json.load(f))
    t = {}
    for part in setting("SOTERIA_TARGETS").split(";"):
        if "=" in part:
            app, vols = part.split("=", 1)
            t[app.strip()] = [v.strip() for v in vols.split(",") if v.strip()]
    return _clean(t)


def write_targets(t):
    path = setting("SOTERIA_TARGETS_FILE")
    if not path:
        return False
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(t, f, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(tmp, path)
    return True


# ---------- Portainer 조회 ----------

def _containers(filters=None):
    q = "all=1" + (f"&filters={urllib.parse.quote(json.dumps(filters))}" if filters else "")
    return portainer_api.get(f"/api/endpoints/{endpoint()}/docker/containers/json?{q}", timeout=10)


def _labeled_volumes():
    """{앱: {볼륨}} — Compose가 만든 볼륨의 라벨(com.docker.compose.project)로 묶는다(11/19).
    Portainer는 스택을 정지하면 컨테이너를 지우므로, 컨테이너만 보면 정지된 앱의 볼륨을 놓친다. 볼륨 라벨은 남는다."""
    data = portainer_api.get(f"/api/endpoints/{endpoint()}/docker/volumes", timeout=10) or {}
    found = {}
    for v in (data.get("Volumes") or []) if isinstance(data, dict) else []:
        proj = (v.get("Labels") or {}).get("com.docker.compose.project")
        if proj and v.get("Name"):
            found.setdefault(proj, set()).add(v["Name"])
    return found


def _stack_names():
    """이 환경의 Portainer Compose 스택 이름(정지된 것 포함)."""
    return {st.get("Name") for st in portainer_api.get("/api/stacks", timeout=10) or []
            if st.get("EndpointId") == endpoint() and st.get("Type") == 2 and st.get("Name")}


def discover_targets():
    """Portainer에서 지금 있는 앱(Compose 프로젝트)과 그 앱이 쓰는 볼륨을 찾는다. 관리용 스택·설치판·Portainer 볼륨은 뺀다.
    11/19: 컨테이너가 연결한 볼륨 + 볼륨 라벨. 라벨로 찾은 볼륨은 컨테이너가 있거나 Portainer 스택으로 남아 있는(정지된) 앱 것만 넣는다
    (스택을 지우고 남긴 볼륨까지 계속 백업 대상으로 두지 않기 위해)."""
    found = {}
    for c in _containers():
        proj = (c.get("Labels") or {}).get("com.docker.compose.project")
        if not proj:
            continue
        for m in c.get("Mounts") or []:
            if m.get("Type") == "volume" and m.get("Name"):
                found.setdefault(proj, set()).add(m["Name"])
    labeled = _labeled_volumes()
    for proj in (set(found) | _stack_names()) & set(labeled):
        found.setdefault(proj, set()).update(labeled[proj])
    return _clean({k: sorted(v) for k, v in found.items()})


def all_volumes(t=None):
    """{볼륨: 앱}"""
    return {v: app for app, vols in (t if t is not None else targets()).items() for v in vols}


def running_users(vol):
    """이 볼륨을 쓰는 켜진 컨테이너 이름(백업 컨테이너 제외). 조회 실패면 PortainerError."""
    names = []
    for vol in [vol]:
        for c in _containers({"volume": [vol]}):
            name = str((c.get("Names") or ["?"])[0]).lstrip("/")
            proj = (c.get("Labels") or {}).get("com.docker.compose.project", "")
            if proj in MANAGED_STACKS or name.startswith("bosun-backup") or name.startswith(stack_name()):
                continue
            if c.get("State") == "running" and name not in names:
                names.append(name)
    return names


def stack_volumes(app):
    """이 앱(Compose 프로젝트)의 볼륨 이름 목록: 컨테이너가 연결한 것 + 그 앱 라벨이 붙은 것(11/19, 정지된 앱도 찾는다).
    조회 실패면 PortainerError."""
    vols = set()
    for c in _containers({"label": [f"com.docker.compose.project={app}"]}):
        for m in c.get("Mounts") or []:
            if m.get("Type") == "volume" and m.get("Name"):
                vols.add(m["Name"])
    vols |= _labeled_volumes().get(app, set())
    return sorted(vols)


def volume_size(vols):
    """볼륨 크기 합(바이트). 모르면 None."""
    try:
        sizes = {v.get("Name"): (v.get("UsageData") or {}).get("Size")
                 for v in portainer_api.get(f"/api/endpoints/{endpoint()}/docker/system/df", timeout=10).get("Volumes") or []}
    except portainer_api.PortainerError:
        return None
    total = 0
    for v in vols:
        s = sizes.get(v)
        if not isinstance(s, int) or s < 0:
            return None
        total += s
    return total


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}GB"


def estimate_text(vols):
    size = volume_size(vols)
    if size is None:
        return "크기를 확인하지 못했습니다(큰 데이터는 몇 분 걸릴 수 있습니다)."
    sec = max(1, int(size / BYTES_PER_SEC) + 2)
    return f"데이터 크기 약 {human(size)}, 예상 {sec}초 안팎."


# ---------- 창구 스택(bosun-soteria) ----------

def build_compose(t):
    """백업 대상 목록으로 창구 스택 Compose를 만든다. 앱 볼륨은 모두 읽기 전용, 주소는 127.0.0.1에만."""
    port = setting("SOTERIA_PORT", "18090")
    archive = setting("SOTERIA_ARCHIVE_VOLUME", "bosun_soteria_backups")
    lines = ["services:", "  soteria:",
             f"    image: {setting('SOTERIA_IMAGE', 'soteria:test')}",
             '    entrypoint: ["/usr/bin/backup"]',
             '    command: ["serve", "-http-addr", ":8080"]',
             "    restart: unless-stopped",
             "    environment:",
             "      TZ: Asia/Seoul",
             "      LOCK_TIMEOUT: 10s",
             '      BACKUP_RETENTION_DAYS: "7"',
             "      BACKUP_PRUNING_PREFIX: job-",
             "    labels:",
             "      bosun.role: managed-backup",
             "    ports:",
             f'      - "127.0.0.1:{port}:8080"',
             "    volumes:",
             f"      - {archive}:/archive"]
    keys = {}
    for vol in sorted(all_volumes(t)):
        key = "v_" + re.sub(r"[^A-Za-z0-9_]", "_", vol)[:120]
        keys[key] = vol
        lines.append(f"      - {key}:/backup/{vol}:ro")
    net = env_or_file("SOTERIA_NETWORK")  # 11/15 컨테이너 설치판: bosun 컨테이너와 같은 네트워크에 이름 bosun-soteria로
    if net:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", net):
            raise ValueError(f"SOTERIA_NETWORK 이름이 이상합니다: {net}")
        lines += ["    networks:", "      default: {}", f"      {net}:", "        aliases: [bosun-soteria]"]
    lines += ["volumes:", f"  {archive}:", "    external: true"]
    for key, vol in keys.items():
        lines += [f"  {key}:", "    external: true", f"    name: {vol}"]
    if net:
        lines += ["networks:", f"  {net}:", "    external: true"]
    return "\n".join(lines) + "\n"


def find_stack():
    for st in portainer_api.get("/api/stacks", timeout=10) or []:
        if st.get("Name") == stack_name() and st.get("EndpointId") == endpoint():
            return st
    return None


def wait_healthy(seconds=None):
    seconds = float(setting("SOTERIA_HEALTH_WAIT", "30")) if seconds is None else seconds
    url = f"{api_base()}/healthz"
    end = time.time() + seconds
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except OSError:
            pass
        time.sleep(1)
    return False


def _creator_created():
    """창구 컨테이너가 만들어진 시각(목록의 Created). 없거나 모르면 None."""
    try:
        cs = _containers({"label": [f"com.docker.compose.project={stack_name()}"]})
        return max((c.get("Created") or 0) for c in cs) if cs else None
    except portainer_api.PortainerError:
        return None


def redeploy(stack_id, compose):
    """창구 스택 Compose를 바꿔 다시 배포하고, 새 컨테이너가 뜰 때까지 기다린다(옛 컨테이너 응답에 속지 않도록)."""
    before = _creator_created()
    portainer_api.request_json("PUT", f"/api/stacks/{stack_id}?endpointId={endpoint()}",
                               {"StackFileContent": compose, "Env": [], "Prune": False, "PullImage": False}, timeout=180)
    end = time.time() + float(setting("SOTERIA_HEALTH_WAIT", "30"))
    while before is not None and time.time() < end and _creator_created() == before:
        time.sleep(1)
    return wait_healthy()


def sync_targets(wait_for=None, wait_seconds=20):
    """지금 있는 앱 볼륨을 찾아 백업 대상 목록과 창구 스택을 맞춘다.
    wait_for: 방금 만든 앱 이름. 그 앱 컨테이너가 보일 때까지 잠깐 기다린다.
    돌려주는 값: (추가된 앱 목록, 빠진 앱 목록). 실패하면 PortainerError/OSError."""
    if wait_for:
        end = time.time() + wait_seconds
        while time.time() < end and wait_for not in discover_targets() and not _containers(
                {"label": [f"com.docker.compose.project={wait_for}"]}):
            time.sleep(1)
    new = discover_targets()
    old = targets()
    if new == old:
        return [], []
    st = find_stack()
    if not st:
        raise portainer_api.PortainerError(f"백업 창구 스택 '{stack_name()}'을 찾지 못했습니다(관리자가 먼저 만들어야 합니다).")
    redeploy(st["Id"], build_compose(new))
    write_targets(new)
    return sorted(set(new) - set(old)), sorted(set(old) - set(new))


# ---------- 백업 기록 ----------

def record_path():
    return setting("SOTERIA_RECORD")


def add_record(rec):
    p = record_path()
    if not p:
        return False
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return True


def recent_backup(vol, max_age_min=None, now=None):
    """이 볼륨의 최근 성공 백업 기록(가장 새 것). 없으면 None. 기록 파일을 못 읽으면 OSError. (기록의 app 칸 = 볼륨 이름)"""
    app = vol
    max_age = float(max_age_min if max_age_min is not None else setting("SOTERIA_MAX_AGE_MIN", "30")) * 60
    now = now or time.time()
    best = None
    p = record_path()
    if not p or not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("app") == app and r.get("sha256") and now - float(r.get("recorded_at", 0)) <= max_age:
                if not best or r["recorded_at"] > best["recorded_at"]:
                    best = r
    return best


# ---------- 11/19 백업 기록 보기(backup_status 보강) ----------
# 창구는 작업 목록을 메모리에만 두어, 다시 배포되면(앱 생성·수정, 볼륨 삭제 전 떼기, soteria_setup) 예전 작업을 못 찾는다.
# 성공한 백업은 기록 파일(SOTERIA_RECORD)에 남으므로 거기서 찾는다. 시각은 한국 시간으로 보여 준다(job_id 안 시각은 UTC).
LIST_JOB = "bosun-list-00000000T000000-000000"   # job_id 없이 부른 backup_status → 최근 목록(창구에는 없는 번호)
KST = dt.timezone(dt.timedelta(hours=9), "KST")
_ISO = re.compile(r"(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?")


def kst(value):
    """초(숫자)나 ISO 시각 문자열 → '2026-11-19 19:55:00 (한국 시간)'. 모르면 None. 시간대가 없는 ISO는 UTC로 본다."""
    try:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if value <= 0:   # 11/19: 시각이 비어 0으로 남은 옛 기록 → "1970-01-01"이 아니라 모름
                return None
            t = dt.datetime.fromtimestamp(float(value), dt.timezone.utc)
        else:
            m = _ISO.search(str(value or ""))
            if not m:
                return None
            tz = m.group(3) or "+00:00"
            if tz == "Z":
                tz = "+00:00"
            elif ":" not in tz:
                tz = tz[:3] + ":" + tz[3:]
            t = dt.datetime.fromisoformat(f"{m.group(1)}T{m.group(2)}{tz}")
        return t.astimezone(KST).strftime("%Y-%m-%d %H:%M:%S") + " (한국 시간)"
    except (ValueError, OverflowError, OSError):
        return None


def read_records():
    """기록 파일의 백업 기록(오래된 것부터). 파일이 없으면 빈 목록."""
    p = record_path()
    out = []
    if not p or not os.path.exists(p):
        return out
    with open(p, encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if isinstance(r, dict) and r.get("job_id"):
                out.append(r)
    return out


def find_record(job_id):
    for r in reversed(read_records()):
        if r.get("job_id") == job_id:
            return r
    return None


def record_line(r):
    when = kst(r.get("finished_at")) or kst(r.get("recorded_at")) or "시각 모름"
    size = human(r["size"]) if isinstance(r.get("size"), int) else "크기 모름"
    return (f"- {when} | 볼륨 {r.get('app')} | {size} | 지문 {str(r.get('sha256') or '')[:12]} | job_id {r.get('job_id')}")


def records_text(limit=10):
    rs = read_records()[-limit:]
    if not rs:
        return "기록된 백업이 없습니다(성공한 \"지금 백업\"만 기록됩니다. 정시 백업은 여기에 나오지 않습니다)."
    return ("최근 성공한 백업(새 것부터, 한국 시간):\n" + "\n".join(record_line(r) for r in reversed(rs))
            + "\n(성공한 \"지금 백업\"만 기록됩니다. 정시 백업은 여기에 나오지 않습니다.)")


# ---------- 삭제 전 확인(11/13 정책표 수정본 5.3·5.10·5.11) ----------

def holders(vol):
    """이 볼륨을 연결한 모든 컨테이너 [(이름, 프로젝트, 상태)]. 조회 실패면 PortainerError."""
    out = []
    for c in _containers({"volume": [vol]}):
        name = str((c.get("Names") or ["?"])[0]).lstrip("/")
        proj = (c.get("Labels") or {}).get("com.docker.compose.project", "")
        out.append((name, proj, c.get("State", "")))
    return out


def is_backup_container(name, proj):
    return proj in MANAGED_STACKS or name.startswith("bosun-backup") or name.startswith(stack_name())


def scheduled_backup_holders(vol):
    """정시 백업(bosun-backup)이 잡고 있으면 그 컨테이너 이름들. 관리자가 적은 볼륨은 Agent가 떼지 못한다(11/13 ㉠).
    11/15: 훅이 자동으로 넣은 볼륨(scheduled_backup의 auto_)은 detach()가 떼므로 막지 않는다."""
    held = [n for n, p, _ in holders(vol) if p == "bosun-backup" or n.startswith("bosun-backup")]
    if held:
        import scheduled_backup
        if vol in scheduled_backup.auto_volumes():
            return []
    return held


def missing_backups(vols):
    """최근 성공 백업이 없는 볼륨 목록. 기록을 못 읽으면 OSError."""
    return [v for v in vols if not recent_backup(v)]


def detach(vols):
    """백업 창구(bosun-soteria)와 정시 백업(훅이 넣은 볼륨만, 11/15)에서 이 볼륨들을 떼고 다시 배포한다(삭제 직전, 자동 추가의 반대).
    떼야 Docker가 볼륨을 지울 수 있다. 바뀐 게 없으면 False. 실패하면 PortainerError/OSError."""
    import scheduled_backup
    sched = scheduled_backup.detach(vols)
    return _detach_soteria(vols) or sched


def _detach_soteria(vols):
    t = targets()
    drop = set(vols)
    new = {app: [v for v in vs if v not in drop] for app, vs in t.items()}
    new = {app: vs for app, vs in new.items() if vs}
    if new == t:
        return False
    st = find_stack()
    if not st:
        raise portainer_api.PortainerError(f"백업 창구 스택 '{stack_name()}'을 찾지 못했습니다.")
    redeploy(st["Id"], build_compose(new))
    write_targets(new)
    return True


# ---------- 11/13 스택 삭제 뒤 남은 볼륨 확인 ----------
# Portainer는 스택을 정지(StackStop)하면 컨테이너를 지운다. 그 뒤 StackDelete(removeVolumes)는
# 지울 것을 찾지 못해 볼륨을 남긴다(11/13 웹 시험, Portainer 기록 "No resource found to remove").
# 그래서 삭제 검사 때 볼륨 목록을 적어 두고, 삭제 뒤 결과 훅이 남은 볼륨을 알려 준다(지우기는 AI가 볼륨 삭제로 따로 승인).

def _pending_path():
    p = record_path()
    return os.path.join(os.path.dirname(p), "soteria_pending_delete.json") if p else None


def set_pending_delete(stack_id, vols):
    p = _pending_path()
    if not p:
        return
    try:
        d = json.load(open(p, encoding="utf-8"))
    except (OSError, ValueError):
        d = {}
    d[str(stack_id)] = list(vols)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)


def pop_pending_delete(stack_id):
    p = _pending_path()
    if not p or not os.path.exists(p):
        return []
    try:
        d = json.load(open(p, encoding="utf-8"))
    except (OSError, ValueError):
        return []
    vols = d.pop(str(stack_id), [])
    with open(p, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    return vols


def volume_exists(vol):
    try:
        portainer_api.get(f"/api/endpoints/{endpoint()}/docker/volumes/{urllib.parse.quote(vol, safe='')}", timeout=10)
        return True
    except portainer_api.PortainerError as e:
        if getattr(e, "status", None) == 404:
            return False
        raise
