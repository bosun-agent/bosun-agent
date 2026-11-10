#!/bin/sh
# 세 파일을 하나의 Agent 설정으로 합친다(11/2, mikefarah/yq v4.54.1·docker-agent v1.148.0으로 확인).
#   * 대신 *+ 를 쓴다: * 는 같은 이름의 배열(훅 목록, allow·deny)을 뒤 파일 것으로 통째로 바꿔서 보안 훅이 조용히 빠질 수 있다.
#   합친 뒤 check_merged_config.py로 기준(agent.yaml.example)의 훅·권한이 빠짐없이 한 번씩 있는지 검사한다.
# 사용: sh merge.sh [결과 파일]   (기본: agent.merged.yaml)
set -e
cd "$(dirname "$0")"
OUT="${1:-agent.merged.yaml}"
yq eval-all 'select(fileIndex == 0) *+ select(fileIndex == 1) *+ select(fileIndex == 2)' \
  agent.common.yaml permissions.yaml hooks.yaml > "$OUT"
python3 ../tools/check_merged_config.py "$OUT" ../agent.yaml.example
