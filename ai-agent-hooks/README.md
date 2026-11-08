# ai-agent-hooks — 원본 파일 폴더 (팀원 공유용)

AI Agent(docker-agent) 설정의 원본과 훅을 두는 곳이다. 팀원에게 보낼 때는 이 폴더의 파일을 보낸다.

| 파일 | 용도 |
| --- | --- |
| agent.yaml.example | 설정 원본(기준 설정). 경로는 자리표시자(/절대경로/, /실행폴더/). 초보자용·숙련자용은 tools/make_agents.py로 이 파일에서 만든다 |
| tool_input_transform_direct_policy_guard.py | 정책 훅(허용 목록. 10/31부터 컨테이너 직접 생성·이미지·네트워크 삭제 거부. 11/1부터 이미지 받기 출처 제한, 상세 조회는 안전한 필드만. 11/6부터 정책표대로 일시정지·재개·이미지 검색·네트워크 생성·연결·해제 거부, 시스템 정보·네트워크·이미지 이력도 안전한 필드만) |
| tool_input_transform_direct_backup_guard.py | 삭제 전 백업 훅(10/31부터 컨테이너만 백업) |
| tool_input_transform_stack_guard.py | 스택(Compose) 검사 훅. PyYAML 필요. 11/1부터 restart 제한, 공개 포트 1024~65535(9443·8000 제외), 서비스당 메모리 2GB·CPU 2개 상한(안 적으면 512MB·CPU 1개로 채움). 11/6부터 같은 이름 생성 거부, 스택 수정(StackUpdate)·파일 보기(StackFileInspect) 검사, 켜기·끄기 대상 확인, 관리 스택(bosun-backup) 보호. 훅 env에 AGENT_ENV_FILE 필요 |
| tool_response_transform_secret_mask.py | 도구 결과의 비밀값 가리기 훅. 11/1부터 Docker 로그 머리 제거, 오류가 나면 결과 전체를 숨김. 11/6부터 스택 파일 보기 결과도 가림 |
| tool_guard_approval_explainer.py | 승인 카드 설명 훅(11/1). 실행될 요청을 쉬운 말과 영향(low·medium·high)으로 설명해 승인 이벤트의 metadata에 붙인다. 판정은 하지 않음 |
| tool_response_transform_backup_runner.py | "지금 백업" 실행 훅(11/2). 승인된 백업 준비(exec 만들기) 뒤에 같은 backup 명령인지 확인하고 바로 실행해 백업 로그를 돌려준다 |
| session_start_app_summary.py | 이어서 하기(11/7). 대화 시작 때 지금 있는 앱(스택·컨테이너·공개 포트·데이터 볼륨·백업 연결) 요약을 AI에게 넣는다. 조회만, 비밀값 가림·인젝션 줄 제외, 실패하면 아무것도 넣지 않음. 훅 env에 AGENT_ENV_FILE 필요 |
| tools/make_agents.py | 초보자용·숙련자용 Agent 설정을 기준 설정에서 만든다(11/6). 초보자용은 '계획 먼저 보여 주기' 규칙 |
| tests/policy_1107_test.py | 11/7 이어서 하기 요약 훅 테스트 |
| tests/policy_1108_test.py | 11/8 변경 요청에는 select를 빼고 보내기(잘못된 select로 '실행됐는데 오류' → 재요청 방지) |
| user_prompt_submit_injection_guard.py | 사용자 입력 인젝션 차단 |
| before_llm_call_injection_sanitizer.py | 모델 호출 직전 차단 입력 가림 |
| tool_response_transform_injection_guard.py | 도구 응답 인젝션 가림 |
| injection_patterns.py | 인젝션 훅 공용 패턴 |
| portainer_api.py | Portainer 조회 공용 모듈(11/1). 정책 훅(컨테이너를 전체 ID로 고정)과 승인 카드 설명 훅(ID → 이름)이 씀. 훅 env에 AGENT_ENV_FILE 필요 |
| deny_guide.py | 거부 안내 공용 문구(11/1). 막힌 요청을 ① 막힌 것 ② 이유 ③ 대신 할 수 있는 것으로 설명. 정책 훅·스택 검사 훅이 함께 씀. Portainer에서 직접 하라고는 안내하지 않고, 대안이 없으면 "관리자에게 요청" |
| image_source.py | 이미지 출처 제한 공용 규칙(11/1). Docker Hub 공식 이미지만 허용. 스택 검사 훅·정책 훅(이미지 받기)이 함께 씀 |
| tests/policy_guard_test.py | 정책 훅 단독 테스트 |
| tests/policy_1031_test.py | 10/31 변경(스택 검사·비밀값 가리기 등) 테스트 |
| tests/policy_1102_test.py | 11/2 백업 명령 예외 테스트(exec 허용 범위, 2단계 확인, 실행 훅, yaml deny 패턴) |
| yq-split/ | 설정을 세 파일(agent.common·permissions·hooks)로 나눈 것과 합치는 merge.sh(11/2). yq는 * 대신 *+ 로 합친다 |
| tools/check_merged_config.py | 합친 설정 검사(11/2). 기준의 훅·권한이 빠짐없이 한 번씩 있는지, docker-agent가 읽는지 확인 |
| tests/policy_1103_test.py | 11/3 수정 테스트(인젝션 검사의 Docker ID 오탐, 네트워크 연결의 Portainer 보호) |
| tests/policy_1106_test.py | 11/6 변경 테스트(정책표대로: 스택 수정·파일 보기, 같은 이름 거부, 스택 켜기·끄기 대상 확인, 시스템 정보·네트워크·이미지 이력 안전 필드, 수정 승인 카드) |
| tests/fake_portainer.py | 단독 테스트용 가짜 Portainer(11/1). 테스트 파일이 import하면 자동으로 뜸 |
| tests/policy_1101_test.py | 11/1 변경(restart·포트·자원 상한, 이미지 출처, 로그 머리 제거, 오류 시 결과 숨김) 테스트 |

실행할 때: docker-agent 사용 통계를 끈다(TELEMETRY_ENABLED=false). 기본으로 켜져 있고 명령 인자·오류 문구가 Docker 서버로 간다(공식 문서 docs/community/telemetry).
공유하지 않는 것: injection_log.sqlite3, *.bak-*, *.fix-*, __pycache__
실행은 이 폴더에서 하지 않는다. 설정 파일을 둔 실행 폴더에서 한다(저장소 맨 위 README 3절).

보안 정책표 예외(반드시 유지, 11/6): bosun-backup 컨테이너의 backup 명령 exec 하나만 허용("지금 백업"). 정책표 4절은 exec를 모두 막지만, 즉시 백업 방법이 이것뿐이라 예외로 둔다. 상세는 docs/동작기준_테스트목록_11-07.md.
