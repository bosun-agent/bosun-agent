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
  SOTERIA_PORT          창구 주소 포트(기본 18090, 127.0.0.1에만 연다)
  SOTERIA_ARCHIVE_VOLUME 백업 파일 볼륨(기본 bosun_soteria_backups)
  SOTERIA_MAX_AGE_MIN   스택 수정 전 백업이 몇 분 안이어야 하는지(기본 30)
  SOTERIA_HEALTH_WAIT   창구를 다시 배포한 뒤 켜질 때까지 기다리는 최대 초(기본 30)
"""
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


def setting(name, default=""):
    return os.environ.get(name) or default


def endpoint():
    return int(setting("SOTERIA_ENDPOINT_ID", "0") or 0)


def stack_name():
    return setting("SOTERIA_STACK", "bosun-soteria")


# ---------- 백업 대상 목록 ----------

def _clean(t):
    out = {}
    for app, vols in (t or {}).items():
        if not isinstance(app, str) or not APP_RE.fullmatch(app) or app in MANAGED_STACKS or PROTECTED.search(app):
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


def discover_targets():
    """Portainer에서 지금 있는 앱(Compose 프로젝트)과 그 앱이 쓰는 볼륨을 찾는다. 관리용 스택·Portainer 볼륨은 뺀다."""
    found = {}
    for c in _containers():
        proj = (c.get("Labels") or {}).get("com.docker.compose.project")
        if not proj:
            continue
        for m in c.get("Mounts") or []:
            if m.get("Type") == "volume" and m.get("Name"):
                found.setdefault(proj, set()).add(m["Name"])
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
    """이 앱(Compose 프로젝트) 컨테이너가 쓰는 볼륨 이름 목록. 조회 실패면 PortainerError."""
    vols = set()
    for c in _containers({"label": [f"com.docker.compose.project={app}"]}):
        for m in c.get("Mounts") or []:
            if m.get("Type") == "volume" and m.get("Name"):
                vols.add(m["Name"])
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
    lines += ["volumes:", f"  {archive}:", "    external: true"]
    for key, vol in keys.items():
        lines += [f"  {key}:", "    external: true", f"    name: {vol}"]
    return "\n".join(lines) + "\n"


def find_stack():
    for st in portainer_api.get("/api/stacks", timeout=10) or []:
        if st.get("Name") == stack_name() and st.get("EndpointId") == endpoint():
            return st
    return None


def wait_healthy(seconds=None):
    seconds = float(setting("SOTERIA_HEALTH_WAIT", "30")) if seconds is None else seconds
    url = f"http://127.0.0.1:{setting('SOTERIA_PORT', '18090')}/healthz"
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
    """정시 백업(bosun-backup)이 잡고 있으면 그 컨테이너 이름들. 이 볼륨은 Agent가 떼지 못한다(관리자 관리, 11/13 ㉠)."""
    return [n for n, p, _ in holders(vol) if p == "bosun-backup" or n.startswith("bosun-backup")]


def missing_backups(vols):
    """최근 성공 백업이 없는 볼륨 목록. 기록을 못 읽으면 OSError."""
    return [v for v in vols if not recent_backup(v)]


def detach(vols):
    """백업 창구(bosun-soteria)에서 이 볼륨들을 떼고 다시 배포한다(삭제 직전, 자동 추가의 반대).
    떼야 Docker가 볼륨을 지울 수 있다. 바뀐 게 없으면 False. 실패하면 PortainerError/OSError."""
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
