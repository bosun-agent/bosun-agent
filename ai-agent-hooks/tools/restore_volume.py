#!/usr/bin/env python3
"""볼륨 복원(롤백) 도구 — 관리자가 직접 실행한다 (11/18, 보고서 2.5·5.2, 발표 자료 "복원(롤백) 흐름")

왜 관리자 도구인가
  보고서 5.2: "백업은 자동이나 복원은 아직 관리자 절차에 의존한다". 그래서 Agent(AI)에게는 복원 도구를 주지 않고,
  관리자가 이 명령 한 줄로 백업 이력에서 복구한다(보고서 2.5 "백업 이력으로 복구").
  흐름은 발표 자료와 offen 공식 문서(docs/how-tos/restore-volumes-from-backup.md, "rollback an entire volume")를 따른다.

하는 일 (발표 자료 순서)
  0) 백업 이력에서 고른 파일 확인: 지금 백업(bosun_soteria_backups) 또는 정시 백업(bosun_backups).
     지금 백업은 기록(SOTERIA_RECORD)의 SHA-256과 파일을 다시 계산한 값이 같아야 한다.
  1) 정지: 그 볼륨을 쓰는 앱 스택을 Portainer로 정지한다.
  2) 안전 백업: 되돌리기 직전 지금 상태를 한 번 더 묶어 둔다(job-bosun-restore-…, 이 도구로 다시 되돌릴 수 있음).
  3) 볼륨을 잡고 있는 백업 스택(bosun-soteria, bosun-backup)을 잠시 정지한다(잡혀 있으면 Docker가 볼륨을 못 지운다).
  4) 기존 볼륨을 같은 이름·같은 드라이버·같은 라벨(Compose 이름표)로 다시 만든다.
  5) 아카이브를 풀어서 복원한다.
  6) 검증: 볼륨 안 모든 파일의 SHA-256 목록이 백업 파일 안 목록과 같은지 비교한다(앱을 켜기 전, 백업 시점과 동일한지).
  7) 재시작: 백업 스택과 앱 스택을 다시 켜고, 앱 컨테이너가 실행 중인지 확인한다.
  풀기·검증이 실패하면 2)의 안전 백업으로 자동으로 되돌린 뒤 스택을 다시 켠다.

사용 (실행 폴더 기준, 비밀값 파일은 경로로만 넘긴다. 맥 터미널에서 docker 명령이 되어야 한다)
  export AGENT_ENV_FILE=<실행 폴더>/agent.env PORTAINER_TLS_VERIFY=0 SOTERIA_ENDPOINT_ID=3 \\
         SOTERIA_RECORD=<실행 폴더>/soteria_runs.jsonl
  python3 tools/restore_volume.py --volume <볼륨> --list                  # 백업 이력 보기
  python3 tools/restore_volume.py --volume <볼륨> --archive <파일> --dry-run  # 무엇을 할지 미리 보기
  python3 tools/restore_volume.py --volume <볼륨> --archive <파일>          # 실제 복원(yes 입력 확인)
  정시 백업 파일은 여러 앱이 한 파일에 있다. 안에 backup/<볼륨>/ 폴더가 없으면 --path <폴더 이름>으로 고른다.
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import portainer_api  # noqa: E402

REPOS = {"soteria": "bosun_soteria_backups", "scheduled": "bosun_backups"}
MANAGED = ("bosun-soteria", "bosun-backup")
HELPER = os.environ.get("RESTORE_HELPER_IMAGE", "alpine:3.20")
VOL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,254}")
FILE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.+-]{0,200}\.tar\.gz")
PATH_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,254}")
PROTECTED = re.compile(r"portainer|bosun_soteria_backups|bosun_backups", re.I)


class Stop(Exception):
    pass


# ---------- 바깥과 닿는 곳(시험에서 바꿔 끼운다) ----------

def docker(*args, check=True):
    """docker 명령을 실행하고 표준출력을 돌려준다."""
    p = subprocess.run(["docker", *args], capture_output=True, text=True)
    if check and p.returncode != 0:
        raise Stop(f"docker {' '.join(args[:2])} 실패: {(p.stderr or p.stdout).strip()[:400]}")
    return p.stdout


def endpoint():
    return int(os.environ.get("SOTERIA_ENDPOINT_ID", "0") or 0)


def stacks():
    return portainer_api.get("/api/stacks", timeout=10) or []


def stack_action(stack, action):
    portainer_api.request_json("POST", f"/api/stacks/{stack['Id']}/{action}?endpointId={endpoint()}", {}, timeout=180)


def now():
    return datetime.datetime.now(datetime.timezone.utc)


# ---------- 조회 ----------

def volume_info(vol):
    out = docker("volume", "inspect", vol, check=False)
    try:
        data = json.loads(out or "[]")
    except ValueError:
        data = []
    return data[0] if data else None


def holders(vol):
    """[(컨테이너 이름, compose 프로젝트, 상태)]"""
    out = docker("ps", "-a", "--filter", f"volume={vol}", "--format",
                 '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.State}}')
    rows = []
    for line in out.splitlines():
        parts = (line.split("\t") + ["", "", ""])[:3]
        if parts[0]:
            rows.append(tuple(parts))
    return rows


def stack_by_name(name):
    for st in stacks():
        if st.get("Name") == name and st.get("EndpointId") == endpoint():
            return st
    return None


def repo_files(repo):
    out = docker("run", "--rm", "-v", f"{REPOS[repo]}:/a:ro", HELPER, "ls", "-1", "/a", check=False)
    return sorted(f for f in out.split() if FILE_RE.fullmatch(f))


def find_archive(name):
    for repo in REPOS:
        if name in repo_files(repo):
            return repo
    return None


def archive_sha(repo, name):
    out = docker("run", "--rm", "-v", f"{REPOS[repo]}:/a:ro", HELPER, "sha256sum", f"/a/{name}")
    return out.split()[0] if out.strip() else ""


def archive_dirs(repo, name):
    out = docker("run", "--rm", "-v", f"{REPOS[repo]}:/a:ro", HELPER, "sh", "-c",
                 f"tar tzf /a/{name} | cut -d/ -f1-2 | sort -u")
    return sorted({ln.strip("/").split("/", 1)[1] for ln in out.splitlines()
                   if ln.startswith("backup/") and "/" in ln.strip("/")})


def recorded_sha(name):
    p = os.environ.get("SOTERIA_RECORD", "")
    if not p or not os.path.exists(p):
        return None
    best = None
    with open(p, encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("name") == name and r.get("sha256"):
                best = r["sha256"]
    return best


def manifest_cmd(root):
    return f"cd {root} && find . -type f -exec sha256sum {{}} + | sort -k2"


# ---------- 단계 ----------

def plan(args):
    vol = args.volume
    if not VOL_RE.fullmatch(vol) or PROTECTED.search(vol):
        raise Stop(f"이 볼륨은 이 도구로 복원할 수 없습니다: {vol}")
    info = volume_info(vol)
    if not info:
        raise Stop(f"볼륨 '{vol}'이 없습니다. 이름을 docker volume ls로 확인하세요.")
    if not FILE_RE.fullmatch(args.archive or ""):
        raise Stop("--archive에 백업 파일 이름(…tar.gz)을 넣으세요. --list로 이력을 볼 수 있습니다.")
    repo = find_archive(args.archive)
    if not repo:
        raise Stop(f"백업 파일 '{args.archive}'을 지금 백업·정시 백업 어디에서도 찾지 못했습니다.")
    sha = archive_sha(repo, args.archive)
    rec = recorded_sha(args.archive)
    if repo == "soteria":
        if not rec:
            raise Stop("지금 백업 파일인데 백업 기록(SOTERIA_RECORD)에 SHA-256이 없습니다. 기록 파일 경로를 확인하세요.")
        if rec != sha:
            raise Stop("백업 파일의 SHA-256이 기록과 다릅니다(파일이 바뀌었거나 깨짐). 복원하지 않습니다.")
    dirs = archive_dirs(repo, args.archive)
    path = args.path or (vol if vol in dirs else "")
    if not path:
        raise Stop(f"백업 파일 안에 backup/{vol}/ 폴더가 없습니다. 안에 있는 폴더: {', '.join(dirs) or '(없음)'} "
                   "→ --path <폴더 이름>으로 고르세요.")
    if not PATH_RE.fullmatch(path) or path not in dirs:
        raise Stop(f"백업 파일 안에 backup/{path}/ 폴더가 없습니다. 안에 있는 폴더: {', '.join(dirs)}")
    labels = info.get("Labels") or {}
    project = labels.get("com.docker.compose.project", "")
    hs = holders(vol)
    app_stack = stack_by_name(project) if project else None
    others = [h for h in hs if h[1] not in MANAGED and h[1] != project]
    if others:
        raise Stop("앱 스택 밖의 컨테이너가 이 볼륨을 쓰고 있습니다: "
                   + ", ".join(f"{n}({s})" for n, _, s in others) + " → 먼저 정리하세요.")
    if not app_stack and any(h[1] == project and h[2] == "running" for h in hs):
        raise Stop(f"'{project}'은 Portainer 스택이 아니라 이 도구가 정지할 수 없습니다. 앱을 먼저 정지하세요.")
    managed = [st for st in (stack_by_name(n) for n in MANAGED) if st and any(h[1] == st["Name"] for h in hs)]
    return {"vol": vol, "info": info, "labels": labels, "repo": repo, "archive": args.archive, "sha": sha,
            "path": path, "app_stack": app_stack, "managed": managed}


def show(p):
    print(f"복원할 볼륨   : {p['vol']} (앱 스택: {p['app_stack']['Name'] if p['app_stack'] else '없음'})")
    print(f"백업 파일     : {p['archive']} ({'지금 백업' if p['repo'] == 'soteria' else '정시 백업'}, SHA-256 {p['sha'][:16]}…)")
    print(f"파일 안 폴더  : backup/{p['path']}/")
    print("순서: 앱 정지 → 안전 백업 → 백업 스택 잠시 정지(" + (", ".join(s["Name"] for s in p["managed"]) or "없음")
          + ") → 같은 이름으로 볼륨 재생성 → 풀어서 복원 → 백업 시점과 같은지 검증 → 재시작")


def safety_backup(p):
    ts = now().strftime("%Y%m%dT%H%M%S")
    label = re.sub(r"\.{2,}", ".", re.sub(r"[^a-z0-9_.-]", "-", p["vol"].lower())).strip("-.")[:40] or "vol"
    name = f"job-bosun-restore-{label}-{ts}.tar.gz"
    docker("run", "--rm", "-v", f"{p['vol']}:/backup/{p['vol']}:ro", "-v", f"{REPOS['soteria']}:/archive",
           HELPER, "tar", "czf", f"/archive/{name}", "-C", "/", f"backup/{p['vol']}")
    sha = archive_sha("soteria", name)
    rec = os.environ.get("SOTERIA_RECORD", "")
    if rec:
        with open(rec, "a", encoding="utf-8") as f:
            # app 칸을 볼륨 이름으로 두지 않는다: 이 파일은 "복원 전" 상태라 수정·삭제 전 30분 백업 확인에 쓰이면 안 된다
            f.write(json.dumps({"app": f"restore-safety:{p['vol']}", "job_id": name[4:-7], "sha256": sha, "name": name,
                                "kind": "restore-safety", "recorded_at": time.time()}, ensure_ascii=False) + "\n")
    return name


def recreate(p):
    docker("volume", "rm", p["vol"])
    args = ["volume", "create", "--driver", p["info"].get("Driver") or "local"]
    for k, v in sorted((p["info"].get("Options") or {}).items()):
        args += ["--opt", f"{k}={v}"]
    for k, v in sorted(p["labels"].items()):
        args += ["--label", f"{k}={v}"]
    docker(*args, p["vol"])


def extract_and_verify(p, repo, archive, path):
    """풀어서 넣고, 넣은 볼륨과 백업 파일 안 목록의 SHA-256이 같은지 본다. 같으면 True."""
    script = (f"set -e; mkdir -p /x; tar xzf /a/{archive} -C /x; cp -a /x/backup/{path}/. /restore/; "
              f"echo ==ARCHIVE==; {manifest_cmd('/x/backup/' + path)}; echo ==VOLUME==; {manifest_cmd('/restore')}")
    out = docker("run", "--rm", "-v", f"{REPOS[repo]}:/a:ro", "-v", f"{p['vol']}:/restore", HELPER, "sh", "-c", script)
    if "==ARCHIVE==" not in out or "==VOLUME==" not in out:
        return False, 0
    a, v = out.split("==ARCHIVE==", 1)[1].split("==VOLUME==", 1)
    a, v = a.strip().splitlines(), v.strip().splitlines()
    return a == v, len(a)


def start_all(stopped, started):
    """이 도구가 정지한 스택만, 정지한 반대 순서(백업 스택 → 앱)로 다시 켠다."""
    for st in [s for s in stopped if s["Name"] in MANAGED] + [s for s in stopped if s["Name"] not in MANAGED]:
        if st["Id"] in started:
            continue
        try:
            stack_action(st, "start")
            started.add(st["Id"])
        except portainer_api.PortainerError as e:
            print(f"  ! '{st['Name']}' 다시 켜기 실패: {e} → Portainer에서 직접 시작하세요.")


def run(p):
    stopped, started = [], set()
    if p["app_stack"] and p["app_stack"].get("Status") != 2:
        print(f"[1/7] 앱 정지: {p['app_stack']['Name']}")
        stack_action(p["app_stack"], "stop")
        stopped.append(p["app_stack"])
    else:
        print("[1/7] 앱 정지: 이미 꺼져 있거나 앱 스택 없음(건너뜀)")
    print("[2/7] 안전 백업(지금 상태)")
    safety = safety_backup(p)
    print(f"      → {safety}")
    print("[3/7] 백업 스택 잠시 정지")
    for st in p["managed"]:
        if st.get("Status") == 2:
            continue
        stack_action(st, "stop")
        stopped.append(st)
        print(f"      → {st['Name']}")
    left = [h for h in holders(p["vol"])]
    if left:
        start_all(stopped, started)
        raise Stop("아직 볼륨을 잡고 있는 컨테이너가 있어 멈췄습니다(볼륨은 그대로): " + ", ".join(h[0] for h in left))
    print(f"[4/7] 같은 이름으로 볼륨 재생성: {p['vol']}")
    recreate(p)
    print(f"[5/7] 풀어서 복원: {p['archive']} 의 backup/{p['path']}/")
    print("[6/7] 검증: 백업 시점과 같은지(파일별 SHA-256)")
    try:
        ok, n = extract_and_verify(p, p["repo"], p["archive"], p["path"])
    except Stop as e:
        ok, n = False, 0
        print(f"      ! 풀기 실패: {e}")
    if not ok:
        print("      ! 검증 실패 → 안전 백업으로 되돌립니다")
        recreate(p)
        back_ok, _ = extract_and_verify(p, "soteria", safety, p["vol"])
        start_all(stopped, started)
        raise Stop("복원에 실패해 복원 전 상태로 되돌렸습니다." if back_ok else
                   f"복원도, 되돌리기 검증도 실패했습니다. 안전 백업 {safety}로 직접 복원하세요.")
    print(f"      → 파일 {n}개 모두 백업과 같음")
    print("[7/7] 재시작")
    start_all(stopped, started)
    if p["app_stack"] in stopped:
        time.sleep(3)
        running = [h for h in holders(p["vol"]) if h[1] == p["app_stack"]["Name"] and h[2] == "running"]
        print("      → 앱 실행 중" if running else "      ! 앱 컨테이너가 아직 실행 중이 아닙니다. Portainer에서 확인하세요.")
    print(f"완료. 복원 전 상태는 {safety} 로 남아 있습니다(같은 도구로 되돌릴 수 있음).")


def list_history(vol):
    label = re.sub(r"\.{2,}", ".", re.sub(r"[^a-z0-9_.-]", "-", vol.lower())).strip("-.")[:40]
    print(f"[지금 백업] {REPOS['soteria']} — 이 볼륨({vol}) 파일")
    for f in repo_files("soteria"):
        if f.startswith(f"job-bosun-{label}-") or f.startswith(f"job-bosun-restore-{label}-"):
            print("  ", f)
    print(f"[정시 백업] {REPOS['scheduled']} — 여러 앱이 한 파일(안에 backup/{vol}/ 이 있으면 바로 사용)")
    for f in repo_files("scheduled"):
        print("  ", f)


def main(argv=None):
    ap = argparse.ArgumentParser(description="볼륨을 백업 시점으로 되돌린다(관리자용).")
    ap.add_argument("--volume", required=True)
    ap.add_argument("--archive")
    ap.add_argument("--path", help="백업 파일 안 backup/<폴더> 이름(기본: 볼륨 이름)")
    ap.add_argument("--list", action="store_true", help="이 볼륨의 백업 이력만 본다")
    ap.add_argument("--dry-run", action="store_true", help="바꾸지 않고 순서만 보여 준다")
    ap.add_argument("--yes", action="store_true", help="확인 질문 없이 진행")
    args = ap.parse_args(argv)
    try:
        if not endpoint():
            raise Stop("SOTERIA_ENDPOINT_ID(Portainer 환경 ID)를 넣어 실행하세요.")
        if args.list:
            list_history(args.volume)
            return 0
        p = plan(args)
        show(p)
        if args.dry_run:
            print("(미리 보기만 했습니다. 바뀐 것은 없습니다.)")
            return 0
        if not args.yes and input("이 볼륨을 백업 시점으로 되돌립니다. 계속하려면 yes: ").strip() != "yes":
            print("취소했습니다.")
            return 1
        run(p)
        return 0
    except (Stop, portainer_api.PortainerError) as e:
        print(f"멈춤: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
