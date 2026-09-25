# BOSUN — WEB

BOSUN 프로젝트의 WEB 파트. 사용자가 자연어로 컨테이너를 관리하는 채팅 인터페이스.

## 스택 선택

- **Vite + React + TypeScript**: 빠른 dev 서버·HMR, 팀 내 프론트엔드 경험과 궁합.
- **Tailwind CSS v4**: 채팅 UI처럼 컴포넌트 단위 스타일이 잦은 화면에서 생산성이 높음. 별도 config 파일 없이 `@tailwindcss/vite` 플러그인 + `@import "tailwindcss"`로 구성.
- 이전 프로젝트(`capstone-2026`)와는 별도 저장소. BOSUN은 GUI 대시보드가 아니라 채팅이 주 인터페이스이므로 처음부터 새로 구성.

## 실행

```bash
npm install
npm run dev
```

## 목업으로 화면 상태 테스트하기

`npm run dev`로 띄우면 입력창 위에 **DEV 시나리오 버튼**이 나온다(운영 빌드에는 포함되지 않음). 버튼을 누르거나 같은 명령을 입력창에 직접 치면 된다.

| 버튼 | 명령 | 재현되는 상황 |
|---|---|---|
| 일반 응답 | `/reply` | 스트리밍 응답 |
| 오래 생각 | `/slow` | 4초 동안 "생각 중" 상태 |
| 승인 대기 | `/approval` | 승인 카드 → 승인하면 실행 완료, 거부하면 취소 |
| 승인 후 실행 실패 | `/approval-fail` | 승인했지만 도구 실행이 실패 |
| 만료된 승인 | `/expired` | 승인을 눌렀는데 서버에 없는 approvalId(409) |
| 하드 차단 | `/reject` | Secure 차단 안내(버튼 없음) |
| 시스템 오류 | `/error` | Portainer 연결 실패 같은 `error` 이벤트 |
| 연결 끊김 | `/disconnect` | 스트림 도중 연결이 끊김 |

"nginx 삭제해줘"(승인 대기), "전체 삭제해줘"(하드 차단)처럼 키워드로도 기존처럼 분기된다.

## 현재 범위 (채팅 UI 뼈대)

- 메시지 목록(`MessageList`) + 입력창(`ChatInput`)
- 메시지 상태 4종(`MessageStatus`): `thinking`(생각 중) → `streaming`(응답 중, 단어 단위로 흘러나옴) / `pending_approval`(Secure 승인 대기, 승인·거부 버튼 카드) / `rejected`(하드 차단, 사유만 표시하고 버튼 없음)
- AI Agent 연동은 `src/lib/mockAgent.ts`에 목업으로 분리 — [인터페이스 초안](docs/interface-web-agent.md)의 SSE 이벤트 스트림(`AgentClient` 인터페이스, `src/lib/agentProtocol.ts`)을 그대로 흉내냄. 실제 연동 시 같은 인터페이스를 SSE로 구현한 클라이언트로 교체하면 `App.tsx`는 수정 불필요
- 아직 없음: 로그인(JWT), AI Agent와의 실제 인터페이스, 세션 유지

## 디자인 결정 기록

2026-09-24 팀 회의 메모 반영:

- **출력 방식**: 한 번에 vs 스트리밍 중 스트리밍(단어 단위 점진 표시)으로 결정. `ChatMessageBubble`의 `streaming` 상태 + 깜빡이는 커서로 구현.
- **보안 반려 UI**: 버튼과 설명을 섞은 형태로 — `pending_approval`은 설명 텍스트 + 승인/거부 버튼(`ApprovalCard`), `rejected`(하드 차단)는 버튼 없이 사유 설명만(`RejectedNotice`). 이 둘을 구분한 이유는 [[bosun-secure-findings]]의 "하드 경계는 협상 불가 / 나머지는 승인 게이트" 구분과 대응시키기 위함 — 실제 Secure 정책이 두 갈래이므로 UI도 두 갈래로 미리 분리해둠.
- **대기 상태 표시**: "생각 중"(`thinking`, 점 3개 애니메이션)과 "승인 대기중"(`pending_approval`, 카드+버튼)을 다른 컴포넌트로 분리 — 같은 대기라도 사용자가 취할 수 있는 행동이 다르기 때문(전자는 기다리기만, 후자는 승인/거부 결정 필요).
- **컴포넌트 조립 방식**: 오픈소스 채팅 UI 템플릿을 통째로 가져오는 대신, shadcn류 스타일로 작은 컴포넌트(`ApprovalCard`/`RejectedNotice`/`ChatMessageBubble`)를 직접 조립하는 방식을 선택 — 상태별 UI 분기가 프로젝트 고유 요구사항(Secure 승인/차단)이라 범용 템플릿보다 커스텀 조립이 맞다고 판단.

## 인터페이스 계약 (WEB ↔ AI Agent)

초안: [docs/interface-web-agent.md](docs/interface-web-agent.md) (v0.1, 합의 전). 요약:

- 전송: 메시지 전송은 HTTP POST + SSE 응답 스트림, 승인·거부는 별도 POST(`approvalId` + `decision`만 전송)
- 이벤트 6종: `text_delta` / `tool_status` / `approval_required` / `rejected` / `error` / `done`
- 승인은 서버가 발급한 1회용 `approvalId`에 묶임 — WEB은 파라미터를 다시 보내지 않음
- 팀이 정할 결정은 문서 6장, Docker Agent API 서버 조사 결과는 7장에 정리
