#!/usr/bin/env python3
"""
yq로 합친 Agent 설정 검사 (11/2)

왜 필요한가
  yq의 * 병합은 같은 이름의 배열(훅 목록, allow·deny)을 뒤 파일 것으로 통째로 바꾼다. 오류 없이 보안 훅이 빠진다(11/2 재현).
  *+ 병합은 배열을 이어 붙여서 덜 위험하지만, 같은 파일을 두 번 넣으면 훅이 두 번 등록된다.
  그래서 합친 결과가 기준 설정의 훅·권한을 "빠짐없이, 정확히 한 번씩" 담고 있는지 확인한다.

사용
  python3 tools/check_merged_config.py <합친 yaml> [기준 yaml]
    기준 yaml을 안 주면 같은 폴더 위의 agent.yaml.example을 쓴다.
    경로 자리표시자(/절대경로/, /실행폴더/)와 실제 경로가 달라도 비교되도록 훅은 파일 이름으로 비교한다.
  docker-agent가 있으면 `docker-agent debug config`로 읽히는지도 확인한다.
  결과: 문제가 없으면 종료 코드 0, 있으면 1
필요: PyYAML
"""
import os
import re
import shutil
import subprocess
import sys
from collections import Counter

import yaml

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def hook_entries(doc):
    """(이벤트, matcher, 훅 파일 이름) 목록. 같은 것이 두 번이면 두 번 들어간다."""
    out = []
    hooks = ((doc.get("agents") or {}).get("root") or {}).get("hooks") or {}
    for event, items in hooks.items():
        for item in items or []:
            if isinstance(item, dict) and "hooks" in item:
                for h in item.get("hooks") or []:
                    out.append((event, item.get("matcher", ""), os.path.basename(str(h.get("command", "")).split()[-1])))
            elif isinstance(item, dict):
                out.append((event, "", os.path.basename(str(item.get("command", "")).split()[-1])))
    return out


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    merged_path = sys.argv[1]
    ref_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "agent.yaml.example")
    merged, ref = yaml.safe_load(open(merged_path, encoding="utf-8")), yaml.safe_load(open(ref_path, encoding="utf-8"))
    problems = []

    want, got = Counter(hook_entries(ref)), Counter(hook_entries(merged))
    for k, n in want.items():
        if got[k] < n:
            problems.append(f"훅 빠짐: {k[0]} / matcher {k[1] or '(없음)'} / {k[2]}")
        elif got[k] > n:
            problems.append(f"훅 중복({got[k]}번): {k[0]} / matcher {k[1] or '(없음)'} / {k[2]} — 같은 파일을 두 번 합쳤을 수 있습니다")
    for k in got:
        if k not in want:
            print(f"참고: 기준에 없는 훅이 추가됨: {k[0]} / {k[1] or '(없음)'} / {k[2]}")

    for kind in ("allow", "deny", "ask"):
        w = Counter((ref.get("permissions") or {}).get(kind) or [])
        g = Counter((merged.get("permissions") or {}).get(kind) or [])
        for rule, n in w.items():
            if g[rule] < n:
                problems.append(f"{kind} 빠짐: {rule}")
            elif g[rule] > n:
                problems.append(f"{kind} 중복({g[rule]}번): {rule}")

    rt, mt = (ref.get("agents", {}).get("root", {}).get("toolsets") or []), (merged.get("agents", {}).get("root", {}).get("toolsets") or [])
    want_tools = sorted(t for ts in rt for t in (ts.get("tools") or []))
    got_tools = sorted(t for ts in mt for t in (ts.get("tools") or []))
    if want_tools != got_tools:
        problems.append(f"도구 목록이 다름: 기준 {want_tools} / 합친 것 {got_tools}")

    if shutil.which("docker-agent"):
        r = subprocess.run(["docker-agent", "debug", "config", merged_path], capture_output=True, text=True)
        if r.returncode != 0:
            problems.append("docker-agent가 합친 설정을 읽지 못함: " + re.sub(r"\s+", " ", (r.stderr or r.stdout))[:300])
    else:
        print("참고: docker-agent가 없어 읽기 확인은 건너뜀")

    if problems:
        print("XX 문제 발견")
        for p in problems:
            print("   -", p)
        return 1
    print(f"OK 합친 설정이 기준과 같은 훅 {sum(want.values())}개·권한을 정확히 한 번씩 담고 있습니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
