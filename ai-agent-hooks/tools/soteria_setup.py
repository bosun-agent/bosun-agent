#!/usr/bin/env python3
"""soteria 백업 창구(관리 스택 bosun-soteria)를 처음 만들거나 다시 맞춘다 (11/12, 관리자용 1회 실행)

하는 일
  1) Portainer에서 지금 있는 앱(Compose 스택)과 그 앱 데이터(볼륨)를 찾는다(Portainer·관리 스택 제외).
  2) 창구 스택이 없으면 만들고(볼륨은 모두 읽기 전용, 주소는 127.0.0.1:18090), 있으면 목록을 다시 맞춘다.
  3) 백업 대상 목록 파일(SOTERIA_TARGETS_FILE)을 쓴다. 이후 새 앱은 Agent 훅이 자동으로 추가한다.

사용 (실행 폴더 기준, 비밀값 파일은 경로로만 넘긴다)
  AGENT_ENV_FILE=<실행 폴더>/agent.env PORTAINER_TLS_VERIFY=0 SOTERIA_ENDPOINT_ID=3 \\
  SOTERIA_TARGETS_FILE=<실행 폴더>/soteria_targets.json python3 tools/soteria_setup.py
미리: 백업 파일 볼륨 만들기  docker volume create bosun_soteria_backups
      창구 이미지 만들기     팀원 soteria 저장소에서 docker build -t soteria:test .
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import portainer_api  # noqa: E402
import soteria_common as sc  # noqa: E402


def main():
    if not sc.setting("SOTERIA_TARGETS_FILE") or not sc.endpoint():
        sys.exit("SOTERIA_TARGETS_FILE과 SOTERIA_ENDPOINT_ID를 넣어 실행하세요.")
    t = sc.discover_targets()
    print("백업 대상(앱: 볼륨):")
    for app, vols in sorted(t.items()):
        print(f"  {app}: {', '.join(vols)}")
    st = sc.find_stack()
    body = {"StackFileContent": sc.build_compose(t), "Env": []}
    if st:
        sc.redeploy(st["Id"], body["StackFileContent"])
        print(f"창구 스택 '{sc.stack_name()}'(id {st['Id']})을 다시 맞췄습니다.")
    else:
        r = portainer_api.request_json("POST", f"/api/stacks/create/standalone/string?endpointId={sc.endpoint()}",
                                       {**body, "Name": sc.stack_name()}, timeout=180)
        print(f"창구 스택 '{sc.stack_name()}'(id {r.get('Id')})을 만들었습니다.")
    sc.write_targets(t)
    print("창구 응답:", "정상" if sc.wait_healthy(40) else "아직 응답 없음(잠시 뒤 다시 확인)")


if __name__ == "__main__":
    main()
