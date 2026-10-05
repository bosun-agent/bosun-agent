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

WEB 백엔드까지 같이 돌리려면 터미널 3개를 띄운다. 실제 Agent·Airlock이 없을 때는 가짜 서버를 쓴다.

```bash
npm run server:fake  # 가짜 Docker Agent(8080) + 가짜 Airlock(4113)
npm run server       # WEB 백엔드(3001). 코드를 고치면 다시 뜬다
npm run dev:http     # 화면. /api를 WEB 백엔드로 넘긴다
npm run server:smoke # (선택) 백엔드 흐름 스모크 테스트
```

가짜 Agent는 메시지 키워드로 시나리오를 고른다: 삭제(승인 카드), 만료(10초 뒤 만료), 명령(exec 승인 두 번), 차단, 없는 도구, 목록, 훅, 오류. 개발용 설정값은 `server/dev/dev.env`에 있다. 실제 연동 때는 받은 값으로 별도 env 파일을 만들고 커밋하지 않는다.

### WEB 백엔드 구조 (`server/`)

| 파일 | 하는 일 |
|---|---|
| `main.ts` | 진입점. 시작할 때 Airlock에 남은 대기 건을 거부하고, 대기 목록 보조 조회를 돌린다 |
| `app.ts` | 브라우저용 `/api/*`와 Airlock 전용 `/internal/airlock/webhook` |
| `turns.ts` | 한 턴의 Agent 스트림과 승인 요청 관리(계약 6장): 카드 띄우기, 결정 전달, 만료, 스트림 이어붙이기 |
| `translate.ts` | Docker Agent 이벤트 → 화면 이벤트, 하드 차단 판별 |
| `tools.ts` | 도구 이름 → 화면 문구, 승인 카드 템플릿 |
| `agentClient.ts`, `airlockClient.ts` | Docker Agent API, Airlock management API 클라이언트 |
| `mask.ts` | 알려진 비밀값 형식 가리기 |
| `store.ts` | 승인·차단 카드와 승인 감사 기록(지금은 메모리) |

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

- **레이아웃**(2026-09-29 팀 와이어프레임 기준): 빈 대화는 가운데에 제목·입력창(Home), 대화가 시작되면 가운데 칼럼에 메시지와 아래 입력창. 헤더 없이 왼쪽 위 ☰ 버튼만 둔다
- **대화 목록**(`SessionSidebar`): ☰로 열고 닫는 사이드바, 새 대화, 처리 중 표시. 대화가 여러 개여도 처리는 한 번에 한 대화만 한다(인터페이스 계약 3장)
- **처리 과정**(`ProcessSteps`): 도구 목록 불러오기 → 요청 이해 → 도구 호출 → 승인 대기 → 실행을 실시간으로 보여주고, 끝나면 "처리 과정 보기"로 접는다. 도구 인자와 원본 결과는 보여주지 않는다
- **메시지 상태**(`MessageStatus`): `thinking`, `streaming`, `done`, `pending_approval`(승인 카드), `approval_expired`, `rejected`(하드 차단, 버튼 없음), `error`
- 화면은 `AgentClient` 인터페이스(`src/lib/agentProtocol.ts`)만 본다. 목업(`mockAgent.ts`)과 WEB 백엔드 클라이언트(`httpAgent.ts`) 중 하나를 `src/lib/agent.ts`가 고른다(`VITE_AGENT=http`)
- 라이트 모드 고정(다크 모드는 2026-09-29 피드백에 따라 제거)
- WEB 백엔드(`server/`): 가짜 Agent·Airlock으로 승인·거부·만료·차단까지 확인함
- 아직 없음: 로그인(JWT), 실제 Agent·Airlock 연동, 카드 저장소 SQLite, 화면의 대화 복원(백엔드 API는 있음)

## 디자인 결정 기록

2026-09-24 팀 회의 메모 반영:

- **출력 방식**: 한 번에 vs 스트리밍 중 스트리밍(단어 단위 점진 표시)으로 결정. `ChatMessageBubble`의 `streaming` 상태 + 깜빡이는 커서로 구현.
- **보안 반려 UI**: 버튼과 설명을 섞은 형태로 — `pending_approval`은 설명 텍스트 + 승인/거부 버튼(`ApprovalCard`), `rejected`(하드 차단)는 버튼 없이 사유 설명만(`RejectedNotice`). 이 둘을 구분한 이유는 Secure의 "하드 차단은 승인으로도 풀 수 없음 / 나머지는 승인 게이트" 구분과 대응시키기 위함 — 실제 Secure 정책이 두 갈래이므로 UI도 두 갈래로 미리 분리해둠.
- **대기 상태 표시**: "생각 중"(`thinking`, 점 3개 애니메이션)과 "승인 대기중"(`pending_approval`, 카드+버튼)을 다른 컴포넌트로 분리 — 같은 대기라도 사용자가 취할 수 있는 행동이 다르기 때문(전자는 기다리기만, 후자는 승인/거부 결정 필요).
- **컴포넌트 조립 방식**: 오픈소스 채팅 UI 템플릿을 통째로 가져오는 대신, shadcn류 스타일로 작은 컴포넌트(`ApprovalCard`/`RejectedNotice`/`ChatMessageBubble`)를 직접 조립하는 방식을 선택 — 상태별 UI 분기가 프로젝트 고유 요구사항(Secure 승인/차단)이라 범용 템플릿보다 커스텀 조립이 맞다고 판단.

2026-09-29 UI 피드백 반영:

- **레이아웃만 먼저**: 디자인은 뒤로 미루고 와이어프레임 5개 화면(Home, 응답 완료, 사이드바, 처리 과정 승인 대기, 처리 과정 자세히)의 배치를 따름.
- **여러 대화**: 사이드바로 제공하되 처리는 한 번에 하나. Airlock 승인 알림에 대화 식별자가 없어서, 동시에 돌리면 승인 카드를 붙일 대화를 알 수 없기 때문.
- **처리 과정**: 제안대로 실시간 표시 후 접기. 순서는 Docker Agent 실제 동작(도구 목록을 먼저 불러온 뒤 모델 호출)에 맞춤. 이를 위해 `progress` 이벤트 추가(계약 v0.2.8).
- **다크 모드 제거**: 화면이 늘어날수록 스타일을 두 벌 맞추는 부담이 커서 라이트 모드로 고정.

## 문서

| 원본 | 팀 공유용 이름 | 내용 |
|---|---|---|
| [docs/architecture-web.md](docs/architecture-web.md) | `WEB_아키텍처_설계서.md` | WEB 범위·경계, 화면 상태, 기술 선택, WEB 백엔드 역할, 구현 현황 |
| [docs/interface-web-agent.md](docs/interface-web-agent.md) | `WEB_인터페이스_계약.md` | 브라우저 ↔ WEB 백엔드 형식, WEB 백엔드 ↔ Agent/Airlock 승인 흐름, 정할 것 |
| [docs/web-summary.md](docs/web-summary.md) | `WEB_정리.md` | 팀 공유용 요약: WEB이 하는 일, 승인 흐름, 주고받는 데이터, 부탁드리는 것 |

- 원본은 이 저장소에서 고치고, 팀에 공유할 때 공유용 이름으로 복사한다. 설계서 본문은 공유용 이름으로 서로를 가리킨다.
- 요약: 브라우저는 WEB 백엔드하고만 통신한다(HTTP POST + SSE). 승인은 Airlock이 붙잡고, WEB 백엔드가 webhook으로 받아 카드로 띄운 뒤 결정을 management API로 전달한다.
