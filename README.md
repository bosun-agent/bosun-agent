# BOSUN — WEB

BOSUN 프로젝트의 WEB 파트. 사용자가 자연어로 컨테이너를 관리하는 채팅 인터페이스.
이 문서는 실행·설정 안내다.

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
npm run server:smoke # (선택) 백엔드 흐름 스모크 테스트(95항목)
npm run test:ui      # (선택) 브라우저 화면 테스트(43항목). 설치된 Chrome을 쓴다(CHROME_PATH)
npm run test:agent   # (선택) 백엔드가 Agent를 띄우고 다시 시작하는 흐름(9항목). 백엔드를 직접 띄우므로 따로 켤 것이 없다
```

화면은 `AgentClient` 인터페이스(`src/lib/agentProtocol.ts`)만 본다. 목업(`mockAgent.ts`)과 WEB 백엔드 클라이언트(`httpAgent.ts`) 중 하나를 `src/lib/agent.ts`가 고른다(`VITE_AGENT=http`).

`test:ui`는 대화 이름·고정을 확인하므로 깨끗한 상태(가짜 Agent와 백엔드를 새로 띄우고 `WEB_DB_PATH`도 새 파일)에서 돌린다. 캡처를 남기려면 `SHOTS=<폴더>`를 준다.

가짜 Agent는 메시지 키워드로 시나리오를 고른다: 삭제·강제·웹사이트·재시작(승인 카드), 명령·금지(permissions.deny), 차단(훅 거부), 없는 도구, 모르는 도구(문구 표에 없는 도구의 승인 카드), 도구 표기(모델이 도구 호출을 글로 씀), 빈 답(모델이 아무것도 안 냄), 되풀이(Agent 반복 감지), 목록, 천천히(3초 걸리는 답, 멈추기·다시 붙기 확인용), 훅, 오류, 반복(max_iterations), 키 없음, 키 오류. 만료를 보려면 백엔드를 `APPROVAL_TIMEOUT_MS=10000`으로 띄운다. 개발용 설정값은 `server/dev/dev.env`에 있다. 실제 연동 때는 받은 값으로 별도 env 파일을 만들고 커밋하지 않는다.

### 로그인 없음

이 PC에서만 쓰므로 로그인이 없다. 대신 백엔드는 `127.0.0.1`에서만 뜨고(`HOST`를 다른 주소로 주면 시작하지 않는다), Host·Origin이 localhost·127.0.0.1·[::1]이 아닌 요청과 `X-Bosun` 헤더가 없는 변경 요청은 403이다(`server/guard.ts`).

### 진짜 Agent로 띄우기

Docker Desktop과 Portainer 컨테이너(`bosun-portainer`)를 켠 뒤 터미널 2개를 띄운다. PowerShell이든 Git Bash든 같다.

```bash
npm start          # WEB 백엔드(3001) + Docker Agent(8080). 코드를 바꿨으면 다시 띄운다
npm run dev:http   # 화면 → http://localhost:5173
```

둘 다 `server/real.env`(커밋하지 않는다)를 읽는다. `AGENT_BIN`이 있으면 `npm start`가 Docker Agent를 같이 띄우고 관리한다(`server/agentProcess.ts`). Agent가 죽으면 다시 띄우고, 설정 화면에서 API 키를 바꾸면 다시 시작한다(처리 중인 대화가 있으면 끝난 뒤). 상태는 화면 위쪽 안내와 설정 > 정보에 나온다. 끌 때는 각 터미널에서 Ctrl+C를 누르면 Agent도 같이 꺼진다. 백엔드가 강제로 꺼져 Agent가 남았으면 다음 `npm start`가 그 Agent를 끝내고 새로 띄운다. `npm run agent`는 Agent 로그만 따로 보고 싶을 때 쓴다. 그렇게 띄운 Agent가 먼저 떠 있으면 `npm start`는 그것을 쓰고, API 키를 바꿔도 다시 시작하지 못한다. `bosun-portainer`는 끄지 않는다(Agent가 Portainer에 붙지 못한다).

다른 PC에서 처음 할 때는 `server/real.env`를 이렇게 만든다.

```bash
AGENT_BIN=/절대경로/docker-agent        # v1.148.0 이상 실행 파일. Docker Desktop의 docker agent 플러그인은 버전이 낮을 수 있다
AGENT_URL=http://127.0.0.1:8080
AGENT_NAME=agent.direct                 # agent.yaml 파일 이름
AGENT_ENV_FILE=/절대경로/agent.env      # Agent의 API 키·Portainer 키. agent.yaml과 session.db도 이 폴더에 둔다
AGENT_TOKEN=...                         # 아무 긴 값. Agent와 WEB 백엔드가 같이 쓴다
AGENT_MODELS=openrouter/deepseek/deepseek-v4.1-flash
# (선택) MAX_TURNS=3 동시에 처리할 대화 수, BACKUP_DB=Agent 백업 훅 DB, AGENT_CONFIG·AGENT_SESSION_DB=다른 폴더에 둘 때
# (선택) PORTAINER_URL=https://localhost:9443  정책 차단 안내의 "Portainer 열기" 링크. 브라우저에서 여는 주소
```

`PORTAINER_URL`의 Portainer가 자체 서명 인증서를 쓰면 링크를 처음 열 때 브라우저가 경고를 띄운다. 주소가 맞으면 계속 진행하면 된다.

### 배포

```bash
npm run build:web                        # 실제 백엔드에 붙는 화면 빌드 → dist/
STATIC_DIR=dist node --env-file=<env> server/main.ts   # 백엔드가 화면도 내보낸다(한 포트)
docker build -t bosun-web .              # 같은 구성의 이미지. SQLite는 /data(볼륨)
```

`npm run build`는 목업 화면, `npm run build:demo`는 공개 데모(목업 + 시나리오 버튼)다. 로그인이 없으므로 다른 PC에서 접속하게 열지 않는다. 이미지는 컨테이너 안에서만 `0.0.0.0`(`HOST_IN_CONTAINER=1`)으로 뜨니, 실행할 때 `-p 127.0.0.1:3001:3001`처럼 루프백으로만 내보낸다.

## WEB 백엔드 구조 (`server/`)

| 파일 | 하는 일 |
|---|---|
| `main.ts` | 진입점. 시작할 때 대기 중이던 카드를 취소로 바꾼다 |
| `app.ts` | 브라우저용 `/api/*`, 보안 헤더, 화면 파일(`STATIC_DIR`) |
| `turns.ts` | 대화마다 한 턴의 Agent 스트림과 승인 요청 관리: `tool_call_confirmation` → 카드, `/resume`으로 결정 전달, 만료, 스트림 이어붙이기, 멈추기, 다시 붙기(이 턴의 이벤트 기록) |
| `system.ts` | 정보·정책 화면 값: Docker Agent 상태와 agent.yaml에서 고른 필드 |
| `backups.ts` | 백업 화면: Agent 백업 훅의 SQLite를 읽기만 한다. inspect에서 고른 값만 보낸다 |
| `translate.ts` | Docker Agent 이벤트 → 화면 이벤트, 정책 차단 판별 |
| `tools.ts` | 도구 호출(`docker_proxy` method·path, `EndpointList`) → 화면 문구, 승인 카드 템플릿 |
| `agentClient.ts` | Docker Agent API 클라이언트 |
| `mask.ts` | 알려진 비밀값 형식 가리기 |
| `store.ts` | 승인·차단 카드, 승인 감사 기록, 고정한 대화, 설정 값, 턴별 사용량(SQLite, `server/data/web.db`. 커밋하지 않는다) |
| `guard.ts` | 이 PC의 화면만 `/api`를 부르게 막기: Host·Origin 루프백 검사, `X-Bosun` 헤더 검사 |
| `settings.ts` | 설정 화면 값: 모델 목록(`AGENT_MODELS` + 화면에서 더한 것), API 키를 Agent env 파일에 쓰기 |
| `config.ts` | 환경변수 읽기 |
| `agentProcess.ts` | Docker Agent를 자식 프로세스로 띄우고 관리: 죽으면 다시 띄우기, API 키를 바꾸면 다시 시작, 남은 Agent 정리(PID 파일) |
| `runAgent.ts` | `npm run agent`: Agent만 따로 띄운다(로그를 따로 볼 때) |
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
