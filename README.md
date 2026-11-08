# BOSUN — AI Agent

BOSUN 프로젝트의 AI Agent 파트. 초보 사용자가 자연어로 컨테이너(앱)를 만들고 관리할 수 있게 하되,
위험한 작업은 **코드(훅·권한 규칙)와 사람의 승인**이 막는다. 팀 저장소의 `agent` 브랜치에 있다.

- 실행기: docker-agent **v1.148.0** / MCP: mcp-portainer **2.45.1** / Portainer CE **2.45.1** / 모델: deepseek/deepseek-v4.1-flash(OpenRouter)
- 기준 정책: Secure 담당 "MCP 기본 보안 정책 분류표". 정책표와의 차이·예외는 `docs/동작기준_테스트목록_11-07.md`
- 웹(화면·백엔드)은 같은 저장소의 `web` 브랜치. 이 Agent를 웹에 붙이는 방법은 아래 5절

---

## 1. 폴더 구성

```
agent 브랜치
├─ README.md                 이 문서
├─ agent.env.example         비밀값 파일 예시(복사해서 agent.env로)
├─ agents/                   초보자용·숙련자용 Agent 설정 예시
│   ├─ beginner.yaml.example   바꾸기 전에 쉬운 말로 계획을 먼저 보여 주고, 동의하면 실행
│   └─ expert.yaml.example     계획 없이 바로 승인 카드로 확인
├─ ai-agent-hooks/           훅(검사 프로그램)·공용 모듈·도구·테스트
│   ├─ agent.yaml.example      기준 설정(권한·안내문·도구·훅·모델). 두 Agent의 원본
│   ├─ *.py                    훅 10개 + 공용 모듈 4개 (파일별 설명은 ai-agent-hooks/README.md)
│   ├─ tools/                  make_agents.py(두 Agent 만들기), check_merged_config.py(설정 검사)
│   ├─ tests/                  훅 단위 테스트(원할 때만, 7절)
│   └─ yq-split/               설정을 세 파일로 나눈 것과 합치는 스크립트
├─ portainer/portainer-compose.yaml    Portainer 실행(2.45.1 고정)
├─ backup/bosun-backup-compose.yaml    볼륨 백업 컨테이너 예시(offen/docker-volume-backup v2.50.1)
└─ docs/                     동작 기준·테스트 목록, 설계·구현 정리, 복원 절차서
```

## 2. 준비물

| 무엇 | 비고 |
|---|---|
| Docker Desktop + Portainer CE 2.45.1 | `portainer/portainer-compose.yaml`로 실행. Portainer > My account > Access tokens에서 API 키 발급 |
| docker-agent v1.148.0 | `docker-agent version`으로 확인 |
| Python 3 + PyYAML, uv(`uvx`) | 훅이 Python, mcp-portainer는 uvx로 실행 |
| OpenRouter API 키 | 모델 호출 |

## 3. 설치

**1) Agent 실행 폴더를 하나 만든다** (예: `~/bosun/agent-run`). 이 브랜치 폴더와 따로 두는 것을 권장한다.

**2) 비밀값 파일** — 실행 폴더에 `agent.env`를 만든다(커밋 금지).
```bash
cp agent.env.example ~/bosun/agent-run/agent.env
```
값을 채운 뒤 권한을 600으로 둔다.

**3) 설정 파일의 경로 자리표시자를 내 PC 경로로 바꾼다.**
설정 예시의 `/절대경로/`는 이 브랜치의 `ai-agent-hooks/` 절대경로, `/실행폴더/`는 1)의 실행 폴더다.
```bash
H=$(pwd)/ai-agent-hooks/; R=~/bosun/agent-run/
mkdir -p $R/agents
sed "s#/절대경로/#$H#g; s#/실행폴더/#$R#g" ai-agent-hooks/agent.yaml.example > $R/agent.yaml
sed "s#/절대경로/#$H#g; s#/실행폴더/#$R#g" agents/beginner.yaml.example > $R/agents/beginner.yaml
sed "s#/절대경로/#$H#g; s#/실행폴더/#$R#g" agents/expert.yaml.example > $R/agents/expert.yaml
```
Windows는 `python3` 대신 `python`일 수 있다(설정의 `command` 줄).

**4) Portainer가 자체 서명 인증서**면 설정의 `PORTAINER_TLS_VERIFY: "0"`을 그대로 둔다.

## 4. 단독 실행 (터미널)

```bash
cd ~/bosun/agent-run
TELEMETRY_ENABLED=false docker-agent run --env-from-file agent.env --session-db ~/bosun/agent-run/session.db agents/beginner.yaml
```
숙련자용은 마지막을 `agents/expert.yaml`로. 승인 질문에는 **Y(승인)·N(거절)만** 쓴다("계속 허용"·Yolo는 쓰지 않는다).

## 5. 웹(`web` 브랜치)과 연결

웹 백엔드가 Agent를 띄운다. 웹 폴더의 `server/real.env`에 아래처럼 적는다.

```
AGENT_BIN=<docker-agent 실행 파일 절대경로>
AGENT_ENV_FILE=<실행 폴더>/agent.env
AGENT_CONFIG=<실행 폴더>/agents
AGENT_NAME=beginner            # 또는 expert
AGENT_URL=http://127.0.0.1:8080
AGENT_TOKEN=<아무 긴 값>
AGENT_MODELS=flash             # 설정에 정의된 모델 이름. 직접 모델 이름을 쓰면 max_tokens 설정이 빠진다
TELEMETRY_ENABLED=false
```
- `AGENT_CONFIG`를 `agents` 폴더로 주면 초보자용·숙련자용이 함께 뜬다(`/agent/beginner`, `/agent/expert`).
- `PORTAINER_URL`(정책 차단 시 "Portainer 열기" 링크)은 넣지 않는다. Agent는 Portainer에서 직접 하라고 안내하지 않는다.
- 웹에서 세션은 고정 제목(`{"title":"새 대화"}`)으로 만들고, 승인은 approve/reject만 쓰는 것을 권장한다(이유: `docs/`).

## 6. 볼륨 백업

- `backup/bosun-backup-compose.yaml`은 현재 쓰는 설정 예시다. 볼륨 이름은 실제 앱 볼륨으로 바꾸고, 모두 **읽기 전용(`:ro`)**으로 붙인다. Portainer에서 스택 `bosun-backup`으로 만든다.
- 매일 밤 11시(한국 시간, `TZ=Asia/Seoul`) 자동 백업, 7일 보관. 그 시간에 서버가 꺼져 있으면 건너뛴다.
- "지금 백업해줘" → Agent가 승인 1번 받고 `backup` 명령을 실행한다. **정책표 4절(exec 금지)의 유일한 예외**로, bosun-backup 컨테이너의 backup 명령 하나만 허용한다.
- 복원은 관리자 작업: `docs/복원절차서_관리자용_11-07.md`

## 7. (원할 때만) 훅 단위 테스트

팀원은 실행하지 않아도 된다. 웹에서 대화로 확인하면 된다.
**훅·설정을 고쳤을 때** 막아야 할 것이 그대로 막히는지 확인하려면 아래를 실행한다. AI·실제 Portainer 없이(가짜 Portainer) 1~2분, 비용 0원이다.

```bash
cd ai-agent-hooks
for t in tests/policy_1031_test.py tests/policy_1101_test.py tests/policy_1102_test.py tests/policy_1103_test.py tests/policy_1106_test.py tests/policy_1107_test.py; do python3 $t | tail -1; done
python3 tests/policy_guard_test.py tool_input_transform_direct_policy_guard.py | tail -1
```
줄마다 `67/67 통과`처럼 모두 통과면 정상(총 279개). 설정 검사:
```bash
python3 tools/check_merged_config.py <실행 폴더>/agent.yaml agent.yaml.example
```

| 테스트 파일 | 확인하는 것 |
|---|---|
| policy_guard_test | 정책 훅 허용 목록, 경로 꼼수 차단, 강제 삭제·로그 무한 받기 차단, 뺀 기능 거부 |
| policy_1031_test | 직접 생성 금지, 스택 위험 설정 차단, 비밀값 가리기, 삭제 전 설정 저장 |
| policy_1101_test | restart·포트·자원 제한, 공식 이미지, ID 고정, 안전 필드, 승인 카드 설명, 거부 안내 |
| policy_1102_test | 백업 명령 예외(그 밖의 exec 거부) |
| policy_1103_test | 인젝션 오탐 수정, 네트워크 연결 거부 |
| policy_1106_test | 스택 수정·파일 보기, 같은 이름 거부, 안전 필드 |
| policy_1107_test | 대화 시작 앱 요약(이어서 하기) |

실제 AI로 하는 시나리오 테스트(T01~T42)는 `docs/동작기준_테스트목록_11-07.md`.

## 8. 규칙을 고칠 때

1. `ai-agent-hooks/agent.yaml.example`(기준 설정) 또는 해당 훅을 고친다. 무엇을 어디서 고치는지는 `ai-agent-hooks/README.md`.
2. 두 Agent를 다시 만든다(초보자용 "계획 먼저" 문구는 `tools/make_agents.py`).
   ```bash
   python3 ai-agent-hooks/tools/make_agents.py <실행 폴더>/agent.yaml <실행 폴더>/agents
   ```
3. 7절 테스트를 돌린다.

## 9. 올리면 안 되는 것

`agent.env`(키), `session.db`(대화 기록), `backups.sqlite3`, `injection_log.sqlite3`, 웹의 `real.env`, 경로가 PC마다 다른 실제 설정(`agent.yaml`, `agents/*.yaml`). `.gitignore`가 막고 있다.
