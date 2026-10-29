# BOSUN — WEB

BOSUN 프로젝트의 WEB 파트. 사용자가 자연어로 컨테이너를 관리하는 채팅 인터페이스.
이 문서는 실행·설정 안내다. 무엇을 왜 이렇게 만들었는지는 [설계서](docs/architecture-web.md), 주고받는 형식은 [인터페이스 계약](docs/interface-web-agent.md)에 있다.

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
npm run server:smoke # (선택) 백엔드 흐름 스모크 테스트(91항목)
npm run test:ui      # (선택) 브라우저 화면 테스트(34항목). 설치된 Chrome을 쓴다(CHROME_PATH)
```

화면은 `AgentClient` 인터페이스(`src/lib/agentProtocol.ts`)만 본다. 목업(`mockAgent.ts`)과 WEB 백엔드 클라이언트(`httpAgent.ts`) 중 하나를 `src/lib/agent.ts`가 고른다(`VITE_AGENT=http`).

`test:ui`는 대화 이름·고정을 확인하므로 깨끗한 상태(가짜 Agent와 백엔드를 새로 띄우고 `WEB_DB_PATH`도 새 파일)에서 돌린다. 캡처를 남기려면 `SHOTS=<폴더>`를 준다.

가짜 Agent는 메시지 키워드로 시나리오를 고른다: 삭제·강제·웹사이트·재시작(승인 카드), 명령·금지(permissions.deny), 차단(훅 거부), 없는 도구, 모르는 도구(문구 표에 없는 도구의 승인 카드), 도구 표기(모델이 도구 호출을 글로 씀), 빈 답(모델이 아무것도 안 냄), 되풀이(Agent 반복 감지), 목록, 천천히(3초 걸리는 답, 멈추기·다시 붙기 확인용), 훅, 오류, 반복(max_iterations), 키 없음, 키 오류. 만료를 보려면 백엔드를 `APPROVAL_TIMEOUT_MS=10000`으로 띄운다. 개발용 설정값은 `server/dev/dev.env`에 있다. 실제 연동 때는 받은 값으로 별도 env 파일을 만들고 커밋하지 않는다.

### 로그인

관리자 한 명이다. 개발용 계정은 `admin` / `bosun-dev-password`(`server/dev/dev.env`). 실제 env는 `npm run set-password -- <env 파일>`로 비밀번호를 정한다. Git Bash(mintty)에서는 입력이 가려지지 않으므로 PowerShell이나 VS Code 터미널에서 실행한다.

### 진짜 Agent로 띄우기

Docker Desktop과 Portainer 컨테이너(`bosun-portainer`)를 켠 뒤 터미널 3개를 띄운다. PowerShell이든 Git Bash든 같다.

```bash
npm run agent      # Docker Agent(8080)
npm start          # WEB 백엔드(3001). 코드를 바꿨으면 다시 띄운다
npm run dev:http   # 화면 → http://localhost:5173
```

셋 다 `server/real.env`(커밋하지 않는다)를 읽는다. 끌 때는 각 터미널에서 Ctrl+C를 누른다. `bosun-portainer`는 끄지 않는다(Agent가 Portainer에 붙지 못한다).

다른 PC에서 처음 할 때는 `server/real.env`를 이렇게 만든다.

```bash
AGENT_BIN=/절대경로/docker-agent        # v1.148.0 이상 실행 파일. Docker Desktop의 docker agent 플러그인은 버전이 낮을 수 있다
AGENT_URL=http://127.0.0.1:8080
AGENT_NAME=agent.direct                 # agent.yaml 파일 이름
AGENT_ENV_FILE=/절대경로/agent.env      # Agent의 API 키·Portainer 키. agent.yaml과 session.db도 이 폴더에 둔다
AGENT_TOKEN=...                         # 아무 긴 값. Agent와 WEB 백엔드가 같이 쓴다
AGENT_MODELS=openrouter/deepseek/deepseek-v4.1-flash
# 아래 셋은 npm run set-password -- server/real.env가 넣는다
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=scrypt$...
JWT_SECRET=...
# (선택) MAX_TURNS=3 동시에 처리할 대화 수, BACKUP_DB=Agent 백업 훅 DB, AGENT_CONFIG·AGENT_SESSION_DB=다른 폴더에 둘 때
# (선택) PORTAINER_URL=https://localhost:9443  정책 차단 안내의 "Portainer 열기" 링크. 브라우저에서 여는 주소
```

`PORTAINER_URL`의 Portainer가 자체 서명 인증서를 쓰면 링크를 처음 열 때 브라우저가 경고를 띄운다. 주소가 맞으면 계속 진행하면 된다.

설정 화면에서 API 키를 바꾸면 `npm run agent`를 다시 띄워야 적용된다. 화면에서 바꾼 비밀번호를 잊었으면 `npm run set-password -- server/real.env`로 다시 정한다.

### 배포

```bash
npm run build:web                        # 실제 백엔드에 붙는 화면 빌드 → dist/
STATIC_DIR=dist node --env-file=<env> server/main.ts   # 백엔드가 화면도 내보낸다(한 포트)
docker build -t bosun-web .              # 같은 구성의 이미지. SQLite는 /data(볼륨)
```

`npm run build`는 목업 화면, `npm run build:demo`는 공개 데모(목업 + 시나리오 버튼)다. 외부에서 접속하게 하려면 HTTPS 리버스 프록시 뒤에 두고 `HOST=0.0.0.0`으로 띄운다. 쿠키는 기본이 `Secure`다.

## WEB 백엔드 구조 (`server/`)

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
| `store.ts` | 승인·차단 카드, 승인 감사 기록, 고정한 대화, 설정 값, 턴별 사용량(SQLite, `server/data/web.db`. 커밋하지 않는다) |
| `auth.ts` | 관리자 로그인과 비밀번호 변경, JWT를 HttpOnly 쿠키로 발급, `X-Bosun` 헤더 검사 |
| `settings.ts` | 설정 화면 값: 모델 목록(`AGENT_MODELS` + 화면에서 더한 것), API 키를 Agent env 파일에 쓰기 |
| `config.ts` | 환경변수 읽기 |
| `setPassword.ts` | `npm run set-password`: env 파일에 관리자 비밀번호 해시 넣기 |
| `runAgent.ts` | `npm run agent`: `server/real.env` 값으로 실제 Docker Agent(`serve api`)를 띄운다 |
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

## 문서

| 원본 | 팀 공유용 이름 | 내용 |
|---|---|---|
| [docs/architecture-web.md](docs/architecture-web.md) | `WEB_아키텍처_설계서.md` | WEB 범위·경계, 화면 상태, 기술 선택, WEB 백엔드 역할, 구현 현황 |
| [docs/interface-web-agent.md](docs/interface-web-agent.md) | `WEB_인터페이스_계약.md` | 브라우저 ↔ WEB 백엔드 형식, WEB 백엔드 ↔ Agent 승인 흐름, 정할 것·남은 일(7장) |

원본은 이 저장소에서 고치고, 팀에 공유할 때 공유용 이름으로 복사한다. 설계서 본문은 공유용 이름으로 서로를 가리킨다.
