"""11/18 관리자 복원 도구(tools/restore_volume.py) 단독 테스트 — docker·Portainer는 가짜로 바꿔 끼운다."""
import io
import json
import os
import sys
import tempfile
from contextlib import redirect_stdout, redirect_stderr

D = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(D, "..", "tools"))
sys.path.insert(0, os.path.join(D, ".."))
import restore_volume as rv  # noqa: E402

results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print(("OK  " if ok else "FAIL") + f" {name}" + ("" if ok else f"  got={got!r} want={want!r}"))


class World:
    """가짜 Docker: 볼륨(파일 사전), 백업 저장소(파일 이름 → (sha, {폴더: 파일 사전})), 컨테이너, 스택."""

    def __init__(self):
        self.volumes = {"app_data": {"driver": "local", "labels": {"com.docker.compose.project": "app",
                                                                   "com.docker.compose.volume": "data"},
                                     "files": {"a.txt": "NOW"}}}
        good = {"app_data": {"a.txt": "OLD", "b.txt": "OLD2"}}
        self.repos = {"bosun_soteria_backups": {"job-bosun-app_data-20261118T010000-abcdef.tar.gz": ("sha-good", good)},
                      "bosun_backups": {"backup-2026-11-18T12-00-00.tar.gz": ("sha-s", {"other": {"x": "1"}, "app_data": {"a.txt": "S"}})}}
        self.containers = [("app-web-1", "app", "running"), ("bosun-soteria-soteria-1", "bosun-soteria", "running"),
                           ("bosun-backup-backup-1", "bosun-backup", "running")]
        self.stacks = [{"Id": 7, "Name": "app", "EndpointId": 3, "Status": 1},
                       {"Id": 8, "Name": "bosun-soteria", "EndpointId": 3, "Status": 1},
                       {"Id": 9, "Name": "bosun-backup", "EndpointId": 3, "Status": 1}]
        self.log = []
        self.break_extract = False
        self.extract_calls = 0

    def docker(self, *a, check=True):
        a = list(a)
        self.log.append(" ".join(a[:3]))
        if a[:2] == ["volume", "inspect"]:
            v = self.volumes.get(a[2])
            return json.dumps([{"Name": a[2], "Driver": v["driver"], "Labels": v["labels"], "Options": {}}] if v else [])
        if a[:2] == ["volume", "rm"]:
            if any(c[0] for c in self.containers if self._uses(c, a[2])):
                raise rv.Stop("volume is in use")
            self.volumes.pop(a[2])
            return ""
        if a[:2] == ["volume", "create"]:
            labels = {}
            for i, x in enumerate(a):
                if x == "--label":
                    k, v = a[i + 1].split("=", 1)
                    labels[k] = v
            self.volumes[a[-1]] = {"driver": a[a.index("--driver") + 1], "labels": labels, "files": {}}
            return a[-1]
        if a[:2] == ["ps", "-a"]:
            vol = a[a.index("--filter") + 1].split("=", 1)[1]
            return "".join(f"{n}\t{p}\t{s}\n" for n, p, s in self.containers if self._uses((n, p, s), vol))
        if a[0] == "run":
            mounts = [a[i + 1] for i, x in enumerate(a) if x == "-v"]
            cmd = a[a.index(rv.HELPER) + 1:]
            repo = next((m.split(":")[0] for m in mounts if m.split(":")[0] in self.repos), None)
            if cmd[:2] == ["ls", "-1"]:
                return "\n".join(self.repos[repo])
            if cmd[0] == "sha256sum":
                name = cmd[1].split("/")[-1]
                return f"{self.repos[repo][name][0]}  {cmd[1]}\n"
            if cmd[0] == "tar" and cmd[1] == "czf":      # 안전 백업
                vol = mounts[0].split(":")[0]
                name = cmd[2].split("/")[-1]
                self.repos["bosun_soteria_backups"][name] = ("sha-safety", {vol: dict(self.volumes[vol]["files"])})
                return ""
            script = cmd[-1]
            name = script.split("/a/")[1].split()[0]
            if "tar tzf" in script:
                return "".join(f"backup/{d}\n" for d in self.repos[repo][name][1]) + "backup/\n"
            if "cp -a" in script:                         # 풀기 + 검증 목록
                self.extract_calls += 1
                path = script.split("/x/backup/")[1].split("/.")[0]
                vol = [m.split(":")[0] for m in mounts if m.endswith(":/restore")][0]
                src = self.repos[repo][name][1][path]
                self.volumes[vol]["files"].update(src)
                if self.break_extract and self.extract_calls == 1:
                    self.volumes[vol]["files"]["junk"] = "x"
                man = lambda d: "\n".join(f"h({v})  ./{k}" for k, v in sorted(d.items()))
                return f"==ARCHIVE==\n{man(src)}\n==VOLUME==\n{man(self.volumes[vol]['files'])}\n"
        raise AssertionError(f"모르는 docker 호출: {a}")

    def _uses(self, c, vol):
        return vol == "app_data" and (c[1] in ("app", "bosun-soteria", "bosun-backup") or c[0] == "stray")

    def stack_action(self, st, action):
        self.log.append(f"stack {action} {st['Name']}")
        if action == "stop":
            self.containers = [c for c in self.containers if c[1] != st["Name"]]
        else:
            self.containers.append((f"{st['Name']}-1", st["Name"], "running"))


def setup(world, record_lines=None):
    rv.docker = world.docker
    rv.stacks = lambda: world.stacks
    rv.stack_action = world.stack_action
    rv.time.sleep = lambda s: None
    rec = os.path.join(tempfile.mkdtemp(), "runs.jsonl")
    with open(rec, "w") as f:
        for r in (record_lines if record_lines is not None else
                  [{"app": "app_data", "name": "job-bosun-app_data-20261118T010000-abcdef.tar.gz", "sha256": "sha-good"}]):
            f.write(json.dumps(r) + "\n")
    os.environ["SOTERIA_RECORD"] = rec
    os.environ["SOTERIA_ENDPOINT_ID"] = "3"
    return rec


def call(*argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = rv.main(list(argv))
    return code, out.getvalue(), err.getvalue()


SOT = "job-bosun-app_data-20261118T010000-abcdef.tar.gz"

# 1) 정상 복원(지금 백업 파일)
w = World(); rec = setup(w)
code, out, err = call("--volume", "app_data", "--archive", SOT, "--yes")
check("R1 정상 복원 종료 코드 0", code, 0)
check("R2 볼륨이 백업 시점과 같음(백업 뒤 파일 없음)", w.volumes["app_data"]["files"], {"a.txt": "OLD", "b.txt": "OLD2"})
check("R3 같은 이름·같은 Compose 라벨로 재생성", w.volumes["app_data"]["labels"],
      {"com.docker.compose.project": "app", "com.docker.compose.volume": "data"})
order = [x for x in w.log if x.startswith("stack") or x.startswith("volume rm") or x.startswith("volume create")]
check("R4 순서: 앱 정지 → 백업 스택 정지 → 지움 → 재생성 → 백업 스택 → 앱 켜기", order,
      ["stack stop app", "stack stop bosun-soteria", "stack stop bosun-backup", "volume rm app_data", "volume create --driver",
       "stack start bosun-soteria", "stack start bosun-backup", "stack start app"])
safety = [n for n in w.repos["bosun_soteria_backups"] if n.startswith("job-bosun-restore-app_data-")]
check("R5 안전 백업이 지금 상태(NOW)로 남음", len(safety) == 1 and w.repos["bosun_soteria_backups"][safety[0]][1] == {"app_data": {"a.txt": "NOW"}}, True)
last = json.loads(open(rec).read().splitlines()[-1])
check("R6 안전 백업 기록은 30분 백업 확인에 안 쓰임(app 칸이 볼륨 이름 아님)", last["app"], "restore-safety:app_data")
check("R7 검증 문구", "모두 백업과 같음" in out and "앱 실행 중" in out, True)

# 2) 미리 보기는 아무것도 안 바꿈
w = World(); setup(w)
code, out, _ = call("--volume", "app_data", "--archive", SOT, "--dry-run")
check("D1 미리 보기 종료 코드 0", code, 0)
check("D2 미리 보기는 지우기·정지 없음", [x for x in w.log if x.startswith(("volume rm", "volume create", "stack"))], [])
check("D3 데이터 그대로", w.volumes["app_data"]["files"], {"a.txt": "NOW"})

# 3) 거부
w = World(); setup(w, record_lines=[])
code, _, err = call("--volume", "app_data", "--archive", SOT, "--yes")
check("X1 지금 백업인데 기록 없음 → 거부", (code, "기록" in err), (2, True))
w = World(); setup(w, record_lines=[{"name": SOT, "sha256": "sha-bad"}])
code, _, err = call("--volume", "app_data", "--archive", SOT, "--yes")
check("X2 SHA-256 다름 → 거부", (code, "다릅니다" in err), (2, True))
check("X3 거부 때 데이터 그대로", w.volumes["app_data"]["files"], {"a.txt": "NOW"})
w = World(); setup(w)
code, _, err = call("--volume", "portainer_data", "--archive", SOT, "--yes")
check("X4 보호 볼륨 거부", code, 2)
code, _, err = call("--volume", "app_data", "--archive", "nope.tar.gz", "--yes")
check("X5 없는 백업 파일 거부", (code, "찾지 못했" in err), (2, True))
code, _, err = call("--volume", "app_data", "--archive", "../x.tar.gz", "--yes")
check("X6 이상한 파일 이름 거부", code, 2)
w = World(); setup(w); w.containers.append(("stray", "", "running"))
code, _, err = call("--volume", "app_data", "--archive", SOT, "--yes")
check("X7 앱 밖 컨테이너가 쓰면 거부", (code, "stray" in err), (2, True))

# 4) 정시 백업 파일(여러 앱): 폴더 자동 선택 / --path
w = World(); setup(w)
code, out, _ = call("--volume", "app_data", "--archive", "backup-2026-11-18T12-00-00.tar.gz", "--yes")
check("S1 정시 백업에서 backup/app_data 자동 선택", (code, w.volumes["app_data"]["files"]), (0, {"a.txt": "S"}))
w = World(); setup(w)
code, _, err = call("--volume", "app_data", "--archive", "backup-2026-11-18T12-00-00.tar.gz", "--path", "missing", "--yes")
check("S2 없는 --path 거부", (code, "폴더가 없습니다" in err), (2, True))

# 5) 검증 실패 → 안전 백업으로 되돌림
w = World(); setup(w); w.break_extract = True
code, _, err = call("--volume", "app_data", "--archive", SOT, "--yes")
check("F1 검증 실패면 멈춤", code, 2)
check("F2 복원 전 상태(NOW)로 되돌림", w.volumes["app_data"]["files"], {"a.txt": "NOW"})
check("F3 스택은 다시 켜짐", [x for x in w.log if x.startswith("stack start")],
      ["stack start bosun-soteria", "stack start bosun-backup", "stack start app"])

# 6) 이력 보기
w = World(); setup(w)
code, out, _ = call("--volume", "app_data", "--list")
check("L1 이력에 지금 백업·정시 백업 파일", SOT in out and "backup-2026-11-18T12-00-00.tar.gz" in out, True)

# 7) Agent에는 복원 도구를 주지 않는다(보고서 5.2 관리자 절차)
for name in ("../agents/beginner.yaml.example", "../agents/expert.yaml.example", "agent.yaml.example"):
    p = os.path.join(D, "..", name) if not name.startswith("..") else os.path.join(D, "..", name)
    if os.path.exists(p):
        check(f"A1 {os.path.basename(name)}: 복원 도구 없음", "restore_volume" in open(p, encoding="utf-8").read(), False)

print(f"\n{sum(results)}/{len(results)} 통과")
