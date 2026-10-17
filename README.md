# BOSUN — WEB

BOSUN 프로젝트의 WEB 파트. 사용자가 자연어로 컨테이너를 관리하는 채팅 인터페이스.

## 스택 선택

- **Vite + React + TypeScript**: 빠른 dev 서버·HMR, 팀 내 프론트엔드 경험과 궁합.
- **Tailwind CSS v4**: 채팅 UI처럼 컴포넌트 단위 스타일이 잦은 화면에서 생산성이 높음. 별도 config 파일 없이 `@tailwindcss/vite` 플러그인 + `@import "tailwindcss"`로 구성.
- 이전 프로젝트(`capstone-2026`)와는 별도 저장소. BOSUN은 GUI 대시보드가 아니라 채팅이 주 인터페이스이므로 처음부터 새로 구성.

## 실행

```bash
npm install
npm run dev          # 목업으로 화면만
```

WEB 백엔드까지 같이 돌리려면 터미널 3개를 띄운다. 실제 Agent가 없을 때는 가짜 서버를 쓴다.

```bash
npm run server:fake  # 가짜 Docker Agent(8080)
npm run server       # WEB 백엔드(3001). 코드를 고치면 다시 뜬다
npm run dev:http     # 화면. /api를 WEB 백엔드로 넘긴다
npm run server:smoke # (선택) 백엔드 흐름 스모크 테스트(79항목)
npm run test:ui      # (선택) 브라우저 화면 테스트(29항목). 설치된 Chrome을 쓴다(CHROME_PATH)
```

`test:ui`는 대화 이름·고정을 확인하므로 깨끗한 상태(가짜 Agent와 백엔드를 새로 띄우고 `WEB_DB_PATH`도 새 파일)에서 돌린다. 캡처를 남기려면 `SHOTS=<폴더>`를 준다.

가짜 Agent는 메시지 키워드로 시나리오를 고른다: 삭제·강제·웹사이트·재시작(승인 카드), 명령·금지(permissions.deny), 차단(훅 거부), 없는 도구, 목록, 천천히(3초 걸리는 답, 멈추기·다시 붙기 확인용), 훅, 오류, 반복(max_iterations), 키 없음, 키 오류. 만료를 보려면 백엔드를 `APPROVAL_TIMEOUT_MS=10000`으로 띄운다. 개발용 설정값은 `server/dev/dev.env`에 있다. 실제 연동 때는 받은 값으로 별도 env 파일을 만들고 커밋하지 않는다.

실제 Docker Agent(Agent 담당 `agent.direct.yaml`)에 붙일 때 WEB 백엔드 env:

```bash
AGENT_URL=http://127.0.0.1:8080
AGENT_NAME=agent.direct                 # agent.yaml 파일 이름
AGENT_TOKEN=...                         # serve api --auth-token 값
AGENT_MODELS=openrouter/deepseek/deepseek-v4.1-flash
AGENT_ENV_FILE=/절대경로/agent.env      # Agent --env-from-file 파일. 설정 화면에서 API 키를 여기에 쓴다
# 아래 셋은 npm run set-password -- <이 env 파일>이 넣는다
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=scrypt$...
JWT_SECRET=...
# (선택) MAX_TURNS=3 동시에 처리할 대화 수, BACKUP_DB=Agent 백업 훅 DB(기본: AGENT_ENV_FILE 옆 backups.sqlite3)
```

설정 화면에서 API 키를 바꾸면 Docker Agent를 다시 띄워야 적용된다. 화면에서 비밀번호를 바꾼 뒤 잊어버렸으면 `npm run set-password`로 env를 다시 정하면 그 값이 이긴다.

### 배포

```bash
npm run build:web                        # 실제 백엔드에 붙는 화면 빌드 → dist/
STATIC_DIR=dist node --env-file=<env> server/main.ts   # 백엔드가 화면도 내보낸다(한 포트)
docker build -t bosun-web .              # 같은 구성의 이미지. SQLite는 /data(볼륨)
```

`npm run build`는 목업 화면, `npm run build:demo`는 공개 데모(목업 + 시나리오 버튼)다. 외부에서 접속하게 하려면 HTTPS 리버스 프록시 뒤에 두고 `HOST=0.0.0.0`으로 띄운다. 쿠키는 기본이 `Secure`다.

### WEB 백엔드 구조 (`server/`)

| 파일 | 하는 일 |
|---|---|
| `main.ts` | 진입점. 시작할 때 대기 중이던 카드를 취소로 바꾼다 |
| `app.ts` | 브라우저용 `/api/*`, 보안 헤더, 화면 파일(`STATIC_DIR`) |
| `turns.ts` | 대화마다 한 턴의 Agent 스트림과 승인 요청 관리(계약 6장): `tool_call_confirmation` → 카드, `/resume`으로 결정 전달, 만료, 스트림 이어붙이기, 멈추기, 다시 붙기(이 턴의 이벤트 기록) |
| `system.ts` | 정보·정책 화면 값: Docker Agent 상태와 agent.yaml에서 고른 필드 |
| `backups.ts` | 백업 화면: Agent 백업 훅의 SQLite를 읽기만 한다. inspect에서 고른 값만 보낸다 |
| `translate.ts` | Docker Agent 이벤트 → 화면 이벤트, 정책 차단 판별 |
| `tools.ts` | 도구 호출(`docker_proxy` method·path, `EndpointList`) → 화면 문구, 승인 카드 템플릿 |
| `agentClient.ts` | Docker Agent API 클라이언트 |
| `mask.ts` | 알려진 비밀값 형식 가리기 |
| `store.ts` | 승인·차단 카드, 승인 감사 기록, 고정한 대화, 설정 값(SQLite, `server/data/web.db`. 커밋하지 않는다) |
| `auth.ts` | 관리자 로그인과 비밀번호 변경, JWT를 HttpOnly 쿠키로 발급, `X-Bosun` 헤더 검사 |
| `settings.ts` | 설정 화면 값: 모델 목록(`AGENT_MODELS` + 화면에서 더한 것), API 키를 Agent env 파일에 쓰기 |
| `config.ts` | 환경변수 읽기 |
| `setPassword.ts` | `npm run set-password`: env 파일에 관리자 비밀번호 해시 넣기 |
| `dev/` | 개발용 값(`dev.env`), 가짜 Docker Agent(`fakeUpstream.ts`), 백엔드 스모크 테스트(`smoke.ts`), 화면 테스트(`uiSmoke.ts`), 연동 확인용 `agent.yaml` |

## 목업으로 화면 상태 테스트하기

`npm run dev`로 띄우면 화면 맨 아래에 **DEV 시나리오 버튼**이 나온다(운영 빌드에는 포함되지 않음). 버튼을 누르거나 같은 명령을 입력창에 직접 치면 된다.

| 버튼 | 명령 | 재현되는 상황 |
|---|---|---|
| 일반 응답 | `/reply` | 스트리밍 응답 |
| 오래 생각 | `/slow` | 4초 동안 "생각 중" 상태 |
| 승인 대기 | `/approval` | 승인 카드 → 승인하면 실행 완료, 거부하면 취소 |
| 승인 후 실행 실패 | `/approval-fail` | 승인했지만 도구 실행이 실패 |
| 만료된 승인 | `/expired` | 승인을 눌렀는데 서버에 없는 approvalId(409) |
| 10초 뒤 만료 | `/expiring` | 승인 카드 남은 시간이 줄어들다 만료 → 버튼이 사라지고 입력창이 다시 열림 |
| 하드 차단 | `/reject` | Secure 차단 안내(버튼 없음) |
| 시스템 오류 | `/error` | Portainer 연결 실패 같은 `error` 이벤트 |
| 연결 끊김 | `/disconnect` | 스트림 도중 연결이 끊김 |

"nginx 삭제해줘"(승인 대기), "전체 삭제해줘"(하드 차단), "컨테이너 목록 보여줘"(조회, 승인 없이 도구 호출)처럼 키워드로도 분기된다.

## 현재 범위

- **레이아웃**(2026-10-07 팀 와이어프레임 기준): 빈 대화는 가운데에 로고·입력창·예시 버튼·Go to Portainer(Home), 대화가 시작되면 가운데 칼럼에 메시지와 아래 입력창. 헤더 없이 왼쪽 위 ☰ 버튼과 설정 버튼만 둔다. 로고는 아직 자리표시
- **대화 목록**(`SessionSidebar`): ☰로 열고 닫는 사이드바, 새 대화, 찾기, 고정, 이름 바꾸기(더블클릭), 마크다운 내보내기, 처리 중 표시, 토큰 사용량(마우스를 올리면). 대화마다 따로 처리하므로 한 대화가 승인을 기다려도 다른 대화를 쓸 수 있다(동시 `MAX_TURNS`개, 인터페이스 계약 3장)
- **입력창**(`ChatInput`): 처리 중이면 ■ 멈추기. + 메뉴로 텍스트 파일 붙이기(3개, 파일당 50KB)와 도움말(`HelpPanel`: 바로 되는 것 / 승인 받는 것 / 안 되는 것 + 예시)
- **메시지**: 보낸 메시지 수정(그 앞까지 복제한 새 대화에서 다시 보냄), 답 복사, 오류 뒤 다시 시도, 긴 첨부는 접기. 새로고침하거나 창을 닫아도 처리는 계속되고, 다시 열면 그 턴을 처음부터 이어 받는다
- **승인 카드**(`ApprovalCard`): 무엇을 하는지 + "→ 승인하면 어떻게 되는지" + 위험 사유. 옵션(force 등)에는 뜻을 붙이고 요청 원문은 "기술 정보"로 접는다. 다른 탭을 보고 있으면 탭 제목과 브라우저 알림(설정에서 켬)
- **설정**(`SettingsModal`): 모델(고르기·더하기·빼기), API 키, 정책(agent.yaml 읽어서 설명, 보기만), 승인 기록, 백업(삭제 전 백업 목록, 다시 만들기 요청 쓰기), 정보(연결·버전·도구 수·지시문·이 대화 사용량), 계정(비밀번호), 알림
- **처리 과정**(`ProcessSteps`): 도구 목록 불러오기 → 요청 이해 → 승인 대기 → 도구 실행을 실시간으로 보여주고, 끝나면 "처리 과정 보기"로 접는다. 도구 인자와 원본 결과는 보여주지 않는다
- **메시지 상태**(`MessageStatus`): `thinking`, `streaming`, `done`, `pending_approval`(승인 카드), `approval_expired`, `error`. 정책 차단은 상태가 아니라 `rejectionReason`으로 따로 둔다(차단 뒤에도 Agent가 이어서 답할 수 있음)
- 화면은 `AgentClient` 인터페이스(`src/lib/agentProtocol.ts`)만 본다. 목업(`mockAgent.ts`)과 WEB 백엔드 클라이언트(`httpAgent.ts`) 중 하나를 `src/lib/agent.ts`가 고른다(`VITE_AGENT=http`)
- 라이트 모드 고정(다크 모드는 2026-09-29 피드백에 따라 제거)
- WEB 백엔드(`server/`): Docker Agent 자체 승인(`tool_call_confirmation` → `/resume`) 기준. 가짜 Agent로 승인·거부·만료·차단까지 확인함. Airlock은 일단 쓰지 않는다(2026-10-08)
- 대화 복원(`npm run dev:http`): 사이드바에 서버 대화 목록이 나오고, 고르면 내용과 승인·차단 카드가 돌아온다. 새로고침해도 대기 중인 승인 카드를 다시 승인할 수 있다
- 로그인(`http` 모드): 관리자 한 명. 개발용 계정은 `admin` / `bosun-dev-password`(`server/dev/dev.env`). 실제 env는 `npm run set-password -- <env 파일>`로 비밀번호를 정한다. Git Bash(mintty)에서는 입력이 가려지지 않으므로 PowerShell이나 VS Code 터미널에서 실행한다
- 실제 Agent 연동: 로컬 Portainer로 확인함(2026-10-11)

## 디자인 결정 기록

2026-09-24 팀 회의 메모 반영:

- **출력 방식**: 한 번에 vs 스트리밍 중 스트리밍(단어 단위 점진 표시)으로 결정. `ChatMessageBubble`의 `streaming` 상태 + 깜빡이는 커서로 구현.
- **보안 반려 UI**: 버튼과 설명을 섞은 형태로 — `pending_approval`은 설명 텍스트 + 승인/거부 버튼(`ApprovalCard`), `rejected`(하드 차단)는 버튼 없이 사유 설명만(`RejectedNotice`). 이 둘을 구분한 이유는 Secure의 "하드 차단은 승인으로도 풀 수 없음 / 나머지는 승인 게이트" 구분과 대응시키기 위함 — 실제 Secure 정책이 두 갈래이므로 UI도 두 갈래로 미리 분리해둠.
- **대기 상태 표시**: "생각 중"(`thinking`, 점 3개 애니메이션)과 "승인 대기중"(`pending_approval`, 카드+버튼)을 다른 컴포넌트로 분리 — 같은 대기라도 사용자가 취할 수 있는 행동이 다르기 때문(전자는 기다리기만, 후자는 승인/거부 결정 필요).
- **컴포넌트 조립 방식**: 오픈소스 채팅 UI 템플릿을 통째로 가져오는 대신, shadcn류 스타일로 작은 컴포넌트(`ApprovalCard`/`RejectedNotice`/`ChatMessageBubble`)를 직접 조립하는 방식을 선택 — 상태별 UI 분기가 프로젝트 고유 요구사항(Secure 승인/차단)이라 범용 템플릿보다 커스텀 조립이 맞다고 판단.

2026-09-29 UI 피드백 반영:

- **레이아웃만 먼저**: 디자인은 뒤로 미루고 와이어프레임 5개 화면(Home, 응답 완료, 사이드바, 처리 과정 승인 대기, 처리 과정 자세히)의 배치를 따름.
- **여러 대화**: 사이드바로 제공하되 처리는 한 번에 하나. 당시 Airlock 승인 알림에 대화 식별자가 없어서였다. 지금은 관리자 1명 기준이라 턴 상태를 하나로 두려고 유지한다.
- **처리 과정**: 제안대로 실시간 표시 후 접기. 순서는 Docker Agent 실제 동작(도구 목록을 먼저 불러온 뒤 모델 호출)에 맞춤. 이를 위해 `progress` 이벤트 추가(계약 v0.2.8).
- **다크 모드 제거**: 화면이 늘어날수록 스타일을 두 벌 맞추는 부담이 커서 라이트 모드로 고정.

## 문서

| 원본 | 팀 공유용 이름 | 내용 |
|---|---|---|
| [docs/architecture-web.md](docs/architecture-web.md) | `WEB_아키텍처_설계서.md` | WEB 범위·경계, 화면 상태, 기술 선택, WEB 백엔드 역할, 구현 현황 |
| [docs/interface-web-agent.md](docs/interface-web-agent.md) | `WEB_인터페이스_계약.md` | 브라우저 ↔ WEB 백엔드 형식, WEB 백엔드 ↔ Agent 승인 흐름, 정할 것 |
| [docs/web-summary.md](docs/web-summary.md) | `WEB_정리.md` | 팀 공유용 요약: WEB이 하는 일, 승인 흐름, 주고받는 데이터, 부탁드리는 것 |
| [docs/team-needs.md](docs/team-needs.md) | `WEB_팀에_필요한_것.md` | WEB 혼자 할 수 없는 것: 왜 못 하는지, 누구에게 무엇이 필요한지, 받으면 WEB이 할 일 |
| [docs/portfolio-README.md](docs/portfolio-README.md) | (공유 안 함) | 포트폴리오 공개용 README 초안. 공개할 때 루트 README.md로 옮긴다. 화면 캡처는 `docs/images/` |

- 원본은 이 저장소에서 고치고, 팀에 공유할 때 공유용 이름으로 복사한다. 설계서 본문은 공유용 이름으로 서로를 가리킨다.
- 요약: 브라우저는 WEB 백엔드하고만 통신한다(HTTP POST + SSE). 승인은 Docker Agent 정책이 실행을 멈추고 묻고, WEB 백엔드가 그 요청을 카드로 띄운 뒤 결정을 Agent `/resume`으로 전달한다.
