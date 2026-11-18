# BOSUN — AI Agent

BOSUN 프로젝트의 AI Agent 파트. 초보 사용자가 자연어로 컨테이너(앱)를 만들고 관리할 수 있게 하되,
위험한 작업은 **코드(훅·권한 규칙)와 사람의 승인**이 막는다. 코드는 팀 저장소 `main`의 `ai-agent-hooks/`·`agents/`에 있다.

- 실행기: docker-agent **v1.148.0** / MCP: mcp-portainer **2.45.1** / Portainer CE **2.45.1** / 모델: deepseek/deepseek-v4.1-flash(OpenRouter)
- 기준 정책: Secure 담당 "MCP 기본 보안 정책 분류표". 정책표와의 차이·예외는 `docs/동작기준_테스트목록.md`
- 웹(화면·백엔드)은 같은 저장소의 `src/`·`server/`. 이 Agent를 웹에 붙이는 방법은 아래 5절, 웹 자체 안내는 `README-web.md`

---

## 1. 폴더 구성

```
저장소 루트(main)
├─ README.md                 프로젝트 전체 안내
├─ README-web.md             웹(화면·백엔드) 실행·설정 안내
├─ README-agent.md           이 문서
├─ package.json              웹 의존성·스크립트 (웹 폴더에서 npm install)
├─ src/ server/              웹 화면·백엔드
├─ agent.env.example         비밀값 파일 예시(복사해서 agent.env로)
├─ agents/                   초보자용·숙련자용 Agent 설정 예시
│   ├─ beginner.yaml.example   바꾸기 전에 쉬운 말로 계획을 먼저 보여 주고, 동의하면 실행
│   └─ expert.yaml.example     계획 없이 바로 승인 카드로 확인
├─ ai-agent-hooks/           훅(검사 프로그램)·공용 모듈·도구·테스트
│   ├─ agent.yaml.example      기준 설정(권한·안내문·도구·훅·모델). 두 Agent의 원본
│   ├─ *.py                    훅 12개 + 공용 모듈 5개 (파일별 설명은 ai-agent-hooks/README.md)
│   ├─ tools/                  make_agents.py(두 Agent 만들기), check_merged_config.py(설정 검사), soteria_setup.py(백업 창구 만들기)
│   ├─ tests/                  훅 단위 테스트(원할 때만, 7절)
│   └─ yq-split/               설정을 세 파일로 나눈 것과 합치는 스크립트
├─ portainer/portainer-compose.yaml    Portainer 실행(2.45.1 고정)
├─ backup/bosun-backup-compose.yaml    정시 볼륨 백업 컨테이너 예시(offen/docker-volume-backup v2.50.1)
├─ tools/bin/mcp-soteria      "지금 백업" MCP 프로그램(6절에서 만든다, 커밋 안 함)
└─ docs/                     동작 기준·테스트 목록, 설계·구현 정리, 복원 절차서
```

## 2. 준비물

| 무엇 | 비고 |
|---|---|
| Docker Desktop + Portainer CE 2.45.1 | `portainer/portainer-compose.yaml`로 실행. Portainer > My account > Access tokens에서 API 키 발급 |
| docker-agent v1.148.0 | `docker-agent version`으로 확인 |
| Python 3 + PyYAML, uv(`uvx`) | 훅이 Python, mcp-portainer는 uvx로 실행 |
| OpenRouter API 키 | 모델 호출 |
| soteria 이미지·MCP | "지금 백업"용(팀원 soteria 저장소). 만드는 법은 6절 |

## 3. 설치

**0) 저장소를 받는다.**

```bash
git clone https://github.com/bosun-agent/bosun-agent.git
cd bosun-agent
```

**1) Agent 실행 폴더를 하나 만든다** (예: `~/bosun/agent-run`). 저장소 폴더와 따로 두는 것을 권장한다.

**2) 비밀값 파일** — 실행 폴더에 `agent.env`를 만든다(커밋 금지).
```bash
cp agent.env.example ~/bosun/agent-run/agent.env
```
값을 채운 뒤 권한을 600으로 둔다.

**3) 설정 파일의 경로 자리표시자를 내 PC 경로로 바꾼다.**
설정 예시의 `/절대경로/`는 이 저장소의 `ai-agent-hooks/` 절대경로, `/실행폴더/`는 1)의 실행 폴더다.
```bash
H=$(pwd)/ai-agent-hooks/; R=~/bosun/agent-run/
mkdir -p $R/agents
sed "s#/절대경로/#$H#g; s#/실행폴더/#$R#g" ai-agent-hooks/agent.yaml.example > $R/agent.yaml
sed "s#/절대경로/#$H#g; s#/실행폴더/#$R#g" agents/beginner.yaml.example > $R/agents/beginner.yaml
sed "s#/절대경로/#$H#g; s#/실행폴더/#$R#g" agents/expert.yaml.example > $R/agents/expert.yaml
```
Windows는 `python3` 대신 `python`일 수 있다(설정의 `command` 줄).

**4) Portainer가 자체 서명 인증서**면 설정의 `PORTAINER_TLS_VERIFY: "0"`을 그대로 둔다.

## 4. 켜는 순서

Agent는 Portainer를 통해 Docker를 다루므로 **Portainer가 먼저 켜져 있어야** 한다.
1. Docker Desktop 실행
2. Portainer 실행(이 브랜치의 `portainer/portainer-compose.yaml`)
```bash
docker compose -f portainer/portainer-compose.yaml up -d
```
3. Agent 실행 — 터미널 단독(아래 4-1) 또는 웹(5절, 웹 백엔드가 Agent를 띄움)

### 4-1. 단독 실행 (터미널)

```bash
cd ~/bosun/agent-run
TELEMETRY_ENABLED=false docker-agent run --env-from-file agent.env --session-db ~/bosun/agent-run/session.db agents/beginner.yaml
```
숙련자용은 마지막을 `agents/expert.yaml`로. 승인 질문에는 **Y(승인)·N(거절)만** 쓴다("계속 허용"·Yolo는 쓰지 않는다).

## 5. 웹 파트(`src/`·`server/`)와 연결

웹 백엔드가 Agent를 띄운다. 웹 폴더의 `server/real.env`에 아래처럼 적는다.

```
AGENT_BIN=<docker-agent 실행 파일 절대경로>
AGENT_ENV_FILE=<실행 폴더>/agent.env
AGENT_CONFIG=<실행 폴더>/agents
AGENT_NAME=beginner            # 또는 expert
AGENT_URL=http://127.0.0.1:17080 # Agent API 포트. 앱이 자주 쓰는 8080과 겹치지 않게 17080(11/11 웹 담당 요청)
AGENT_TOKEN=<아무 긴 값>
AGENT_MODELS=flash             # 설정에 정의된 모델 이름. 직접 모델 이름을 쓰면 max_tokens 설정이 빠진다
TELEMETRY_ENABLED=false
```
- `AGENT_CONFIG`를 `agents` 폴더로 주면 초보자용·숙련자용이 함께 뜬다(`/agent/beginner`, `/agent/expert`). 웹은 `AGENT_NAME`에 적은 하나를 부른다.
- `PORTAINER_URL`은 넣지 않는다. Agent는 막힌 작업을 Portainer에서 직접 하라고 안내하지 않는다(대신 "① 막힌 것 ② 이유 ③ 대신 할 수 있는 것"을 안내).
- 웹 설정의 "묻지 않기(YOLO)"는 켜도 Agent의 훅과 항상 거부(deny) 규칙은 승인보다 먼저 돌아 그대로 막는다(빠지는 것은 사람 승인 단계뿐).

### 웹 연동 현황 (11/12)

| 항목 | 상태 |
|---|---|
| 조회, 계획 → 승인 → 스택 생성, 정책 차단 안내, "지금 백업"(정지 → 백업 → 시작) | ✅ 웹 화면에서 동작 확인 |
| 승인 카드에 Agent 훅의 쉬운 설명·영향 표시 | 웹 반영(web `043a55d`, 11/11 웹 담당 알림). Agent는 `tool_call_confirmation`의 `metadata.reason`(설명), `metadata.blast_radius`(low·medium·high)로 보낸다 |
| 초보자용/숙련자용 선택 | 웹 반영(web `043a55d`, 11/11 웹 담당 알림). Agent는 둘 다 떠 있으니 요청 주소의 Agent 이름(`beginner`/`expert`)만 바꾸면 된다 |
| 새 대화를 고정 제목(`{"title": "새 대화"}`)으로 만들기 | 웹 반영(web `043a55d`, 11/11 웹 담당 알림). 제목이 빈 대화는 docker-agent가 사용자 입력으로 제목을 지으며, 이 호출엔 보안 훅이 걸리지 않는다 |
| 차단 안내의 "Portainer에서 직접 할 수 있어요" 문구·링크 제거 | 웹 변경 필요 | 

## 6. 볼륨 백업

백업은 두 가지가 함께 돈다.

| | 정시 자동 백업 | 지금 백업(soteria) |
|---|---|---|
| 언제 | 매일 낮 12시·저녁 6시·밤 11시(한국 시간), 7일 보관 | 사용자가 "지금 백업해줘"라고 할 때, 그리고 데이터가 있는 앱을 **수정하기 전에는 반드시** |
| 무엇으로 | `bosun-backup` 스택(offen/docker-volume-backup) | `bosun-soteria` 스택(팀원 soteria, 승인 트리거 백업 API) + MCP `backup_volume`·`backup_status` |
| 대상 | 관리자가 처음에 적은 볼륨 + 데이터(볼륨)가 있는 **새 앱**(11/15부터 훅이 자동으로 넣고, 앱을 지우면 뺀다) | 데이터(볼륨)가 있는 **모든 앱**. 새 앱은 만들거나 고치면 훅이 자동으로 추가 |
| 저장 | `bosun_backups` 볼륨, `backup-날짜.tar.gz`(앱 전부 한 파일) | `bosun_soteria_backups` 볼륨, `job-bosun-볼륨-시각-….tar.gz`(볼륨 하나) |

**지금 백업 규칙(훅이 강제)**
- 앱이 켜져 있으면 거부 → Agent가 정지 → 백업 → 시작 순서로 진행(각각 승인). 쓰는 중 백업은 깨질 수 있어서다.
- 데이터가 있는 앱의 스택 수정은 그 앱 볼륨 전부에 최근 30분 안 성공 백업이 있어야 통과한다(모델이 순서를 건너뛰어도 막힘).
- 백업은 볼륨 하나씩(`/backup/<볼륨 이름>`)만, 작업 번호·보관 폴더는 훅이 정한다. 볼륨이 여러 개인 앱은 볼륨마다 한 번씩(앱은 한 번만 정지). 보관 기간 등 다른 인자는 거부(다른 앱 백업이 지워질 수 있음).
- 컨테이너 안 명령 실행(exec)은 예외 없이 막는다(11/12 팀 결정. 예전의 "백업 명령 exec 예외"는 없앴다).

**처음 한 번 설정(관리자)**
1. soteria 이미지 만들기(팀원 저장소). 11/15 기준 `fix/gate-request-hardening` 브랜치로 만든다(요청 검사 강화. main에 합쳐지면 main으로)
```bash
git clone -b fix/gate-request-hardening https://github.com/bosun-agent/soteria.git ~/soteria-src && cd ~/soteria-src && docker build -t soteria:test .
```
2. MCP 프로그램 만들기(Go 설치 없이 Docker 안에서, 이 브랜치 폴더 `tools/bin/`에 만든다. 맥 Apple Silicon 기준, 인텔 맥은 `GOARCH=amd64`, Windows는 `GOOS=windows`·`mcp-soteria.exe`)
```bash
docker run --rm -v ~/soteria-src:/app:ro -v "$PWD/tools/bin":/out -w /app golang:1.27-alpine sh -c 'GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -o /out/mcp-soteria ./cmd/mcp'
```
3. 백업 파일 볼륨을 만들고, 창구 스택(`bosun-soteria`, 127.0.0.1:18090)을 만든다. 지금 있는 앱 데이터는 자동으로 찾아 읽기 전용으로 붙인다.
```bash
docker volume create bosun_soteria_backups
cd ai-agent-hooks && AGENT_ENV_FILE=<실행 폴더>/agent.env PORTAINER_TLS_VERIFY=0 SOTERIA_ENDPOINT_ID=<환경 ID> SOTERIA_TARGETS_FILE=<실행 폴더>/soteria_targets.json python3 tools/soteria_setup.py
```
- 설정의 `SOTERIA_ENDPOINT_ID`(기본 3)를 Portainer 환경 ID에 맞춘다.
- 정시 자동 백업은 `backup/bosun-backup-compose.yaml`로 Portainer에서 스택 `bosun-backup`을 만든다(볼륨은 실제 앱 볼륨, 모두 `:ro`).
- 복원은 관리자 작업(Agent에는 복원 도구를 주지 않는다). 11/18부터 관리자 복원 도구 `ai-agent-hooks/tools/restore_volume.py`:
  정지 → 안전 백업 → 백업 스택 잠시 정지 → 같은 이름(+Compose 라벨)으로 볼륨 재생성 → 아카이브 풀기 → 파일별 SHA-256로 백업 시점과 같은지 검증 → 재시작.
  `--list`(백업 이력), `--dry-run`(미리 보기). 수동 명령 절차는 `docs/복원절차서_관리자용_11-07.md`

### 6-1. soteria 백업 게이트

11/12 팀 결정으로 "지금 백업"과 "수정·삭제 전 백업"은 soteria(`bosun-agent/soteria` main)로 한다. 기본 설정(`agent.yaml.example`, `agents/*.yaml.example`)에 이미 들어 있다(6절 설치 순서 참고).

- 구성: 관리 스택 `bosun-soteria`(호스트 `127.0.0.1:18090` → 컨테이너 `8080`, 백업 저장 볼륨 `bosun_soteria_backups`). Agent에는 MCP `tools/bin/mcp-soteria`를 `SOTERIA_API=http://127.0.0.1:18090`으로 붙인다.
- 권한: `backup_status`는 조회라 허용, `backup_volume`은 승인 필요(허용 목록에 넣지 않는다). 인자(`source`·`archive`·`retention_days`·`job_id`)는 훅이 검사·정리한다.
- 순서: 데이터가 있는 앱을 수정·삭제하기 전에 최근 30분 안의 soteria 백업이 없으면 훅이 막는다. DB 앱은 정지 → 백업 → 시작 순서로 한다.
- 저장 위치·파일 꺼내는 방법은 `README-backup.md`, 검증 결과와 결정 근거는 `docs/백업게이트_soteria_검증_결정_11-12.md`(이 문서의 18081은 soteria 문서 기본값이고, BOSUN은 18090을 쓴다).
- 복원은 Agent가 하지 않는다. 관리자가 `tools/restore_volume.py`로 백업 이력에서 복구한다(11/18).

### 6-2. 컨테이너 설치판에서 백업 창구 연결 (11/15)

컨테이너 설치판(`docker-compose.yaml`, `container/`)은 bosun 컨테이너 안에서 Agent와 훅이 돈다. 그 안에서 `127.0.0.1`은 컨테이너 자신이라 PC의 창구(`127.0.0.1:18090`)에 닿지 않는다. 그래서 창구를 **같은 도커 네트워크**에 붙이고 **이름으로** 부른다.

| 설정 | 맥·PC 직접 실행(지금) | 컨테이너 설치판 |
|---|---|---|
| `SOTERIA_API`(훅·MCP가 붙는 주소) | 비워 둔다 → `http://127.0.0.1:18090` | `http://bosun-soteria:8080` |
| `SOTERIA_NETWORK`(창구를 붙일 네트워크) | 비워 둔다 | bosun 스택 네트워크 이름(예: `bosun_default`) |
| `mcp-soteria` | `tools/bin/mcp-soteria`(6절 2) | 이미지 안(리눅스용으로 빌드) |

- 훅은 `SOTERIA_API`를 환경변수 → `AGENT_ENV_FILE`(agent.env) 순으로 찾는다. 없거나 http(s) 주소가 아니면 `http://127.0.0.1:<SOTERIA_PORT>`를 쓴다(지금 동작 그대로).
- `SOTERIA_NETWORK`를 주면 `soteria_setup.py`와 새 앱 자동 추가가 만드는 창구 스택이 그 네트워크에 별칭 `bosun-soteria`로 붙는다. 호스트 발행(`127.0.0.1:18090`)은 그대로 남는다.
- 창구는 지금처럼 Portainer가 관리하는 스택 `bosun-soteria`로 둔다(compose 서비스로 넣으면 훅이 다시 배포하지 못해 새 앱 볼륨 자동 추가가 깨진다).
- 정시 백업(`bosun-backup`)은 설치판에서도 처음 한 번 관리자가 스택을 켠다(볼륨 없이 시작해도 된다). 그 뒤 새 앱 볼륨은 훅이 넣는다(`container/README.md` 7절).

### 6-3. 정시 백업에 새 앱 자동 넣기 (11/15, A안)

- 앱을 만들거나 고친 뒤 결과 훅(`tool_response_transform_soteria_sync.py`)이 soteria 백업 대상과 **같은 목록**으로 정시 백업 스택 `bosun-backup`도 맞춘다(`scheduled_backup.py`). 결과 끝에 `[정시 백업] … 넣었습니다`가 붙는다.
- 훅이 넣은 볼륨은 스택 파일에서 키가 `auto_`로 시작한다. 관리자가 적은 볼륨과 그 밖의 설정(시간·시간대·보관 기간·자원 제한)은 건드리지 않는다.
- 앱을 지우면 그 앱 볼륨(`auto_`)을 정시 백업에서도 뺀다. 볼륨까지 지울 때는 삭제 직전에 떼서 Docker가 지울 수 있게 한다. 관리자가 적은 볼륨은 지금처럼 Agent가 지우지 못한다.
- 정시 백업 스택이 없으면 아무것도 하지 않는다. 스택 이름을 바꿨으면 `SCHEDULED_BACKUP_STACK`으로 준다.
- 정시 백업은 배포 서버가 켜져 있는 것을 전제로 한다(맥에서 시험할 때 잠자기 중인 시간은 깨어난 뒤 한 번 몰아서 돈다).
- 한 번 볼륨을 고치면 Portainer가 스택 파일을 다시 쓰므로 원래 파일의 주석은 없어진다. 원본은 `backup/bosun-backup-compose.yaml`에 남아 있다.

## 7. (원할 때만) 훅 단위 테스트

 실행하지 않아도 된다. 웹에서 대화로 확인하면 된다.
**훅·설정을 고쳤을 때** 막아야 할 것이 그대로 막히는지 확인하려면 아래를 실행한다. AI·실제 Portainer 없이(가짜 Portainer) 1~2분, 비용 0원이다.

```bash
cd ai-agent-hooks
for t in tests/policy_1031_test.py tests/policy_1101_test.py tests/policy_1103_test.py tests/policy_1106_test.py tests/policy_1107_test.py tests/policy_1108_test.py tests/policy_1109_test.py tests/policy_1109v_test.py tests/policy_1112_test.py tests/policy_1112s_test.py tests/policy_1113_test.py tests/policy_1115_test.py tests/policy_1115s_test.py tests/policy_1115b_test.py; do python3 $t | tail -1; done
python3 tests/policy_guard_test.py tool_input_transform_direct_policy_guard.py | tail -1
```
줄마다 `67/67 통과`처럼 모두 통과면 정상(총 526개, 11/15 기준). 설정 검사:
```bash
python3 tools/check_merged_config.py <실행 폴더>/agent.yaml agent.yaml.example
```

| 테스트 파일 | 확인하는 것 |
|---|---|
| policy_guard_test | 정책 훅 허용 목록, 경로 꼼수 차단, 강제 삭제·로그 무한 받기 차단, 뺀 기능 거부 |
| policy_1031_test | 직접 생성 금지, 스택 위험 설정 차단, 비밀값 가리기, 삭제 전 설정 저장 |
| policy_1101_test | restart·포트·자원 제한, 공식 이미지, ID 고정, 안전 필드, 승인 카드 설명, 거부 안내 |
| policy_1103_test | 인젝션 오탐 수정, 네트워크 연결 거부 |
| policy_1106_test | 스택 수정·파일 보기, 같은 이름 거부, 안전 필드 |
| policy_1107_test | 대화 시작 앱 요약(이어서 하기) |
| policy_1108_test | 변경 요청에는 select를 빼고 보내기 |
| policy_1109_test | 비밀번호·토큰을 Compose·Env에 적으면 거부, mysql 자동 비밀번호 설정 허용, entrypoint 거부, command·healthcheck는 허용 목록만(정책표 5.7) |
| policy_1109v_test | 데이터 저장 앱(redis·mysql 등)은 이름 있는 볼륨 필수, 이름 없는 볼륨을 쓰는 스택은 수정 거부 |
| policy_1112_test | 컨테이너 삭제의 force·v를 Docker와 같은 기준으로 판단(y·2 등도 참 → 거부) |
| policy_1112s_test | soteria "지금 백업": exec 전부 거부, 백업 검사·기록·새 앱 자동 추가, 수정 전 백업 확인, BOSUN 포트(17080·3001·18090) 보호, 승인 카드 backup-now |
| policy_1113_test | 정책표 수정본: 스택·볼륨·네트워크·컨테이너(v=true) 삭제 조건, CPU·메모리 값 검사 |
| policy_1115_test | 사용자 정책 훅 단독 동작(deny·ask, 파일 없음·깨짐). 11/17부터 설정에는 등록하지 않음 — 정책 보드는 permissions를 직접 고치는 '자유롭게 조정' 방식 |
| policy_1115s_test | 백업 창구 주소(`SOTERIA_API`)·네트워크(`SOTERIA_NETWORK`) 설정, 설치판 대비 |
| policy_1115b_test | 정시 백업에 새 앱 볼륨 자동 넣기·빼기(관리자 볼륨·설정 유지), 삭제 전 검사 |
| restore_1118_test | 관리자 복원 도구: 정지→안전 백업→재생성(같은 이름·라벨)→풀기→SHA-256 검증→재시작 순서, 기록 SHA 불일치·보호 볼륨·앱 밖 사용 거부, 실패 시 안전 백업으로 되돌림, Agent 설정에 복원 도구 없음 |

실제 AI로 하는 시나리오 테스트(T01~T42)는 `docs/동작기준_테스트목록.md`.

## 8. 규칙을 고칠 때

1. `ai-agent-hooks/agent.yaml.example`(기준 설정) 또는 해당 훅을 고친다. 무엇을 어디서 고치는지는 `ai-agent-hooks/README.md`.
2. 두 Agent를 다시 만든다(초보자용 "계획 먼저" 문구는 `tools/make_agents.py`).
   ```bash
   python3 ai-agent-hooks/tools/make_agents.py <실행 폴더>/agent.yaml <실행 폴더>/agents
   ```
3. 7절 테스트를 돌린다.

## 9. 올리면 안 되는 것

`agent.env`(키), `session.db`(대화 기록), `backups.sqlite3`, `injection_log.sqlite3`, 웹의 `server/real.env`, 경로가 PC마다 다른 실제 설정(`agent.yaml`, `agents/*.yaml`). `.gitignore`가 막고 있다.
