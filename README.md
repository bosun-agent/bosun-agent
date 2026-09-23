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

## 현재 범위 (채팅 UI 뼈대)

- 메시지 목록(`MessageList`) + 입력창(`ChatInput`)
- 메시지 상태 4종(`MessageStatus`): `thinking`(생각 중) → `streaming`(응답 중, 단어 단위로 흘러나옴) / `pending_approval`(Secure 승인 대기, 승인·거부 버튼 카드) / `rejected`(하드 차단, 사유만 표시하고 버튼 없음)
- AI Agent 연동은 `src/lib/mockAgent.ts`에 목업으로 분리 — 실제 연동 시 이 파일의 `askAgent(text)` 함수만 실제 API/WebSocket 호출로 교체하면 됨. 지금은 파괴적 키워드(삭제/지워/제거/중지/재시작) 포함 여부로 `reply` / `approval_required` / `rejected`를 분기하는 규칙 기반 목업
- 아직 없음: 로그인(JWT), AI Agent와의 실제 인터페이스, 세션 유지

## 디자인 결정 기록

2026-09-24 팀 회의 메모 반영:

- **출력 방식**: 한 번에 vs 스트리밍 중 스트리밍(단어 단위 점진 표시)으로 결정. `ChatMessageBubble`의 `streaming` 상태 + 깜빡이는 커서로 구현.
- **보안 반려 UI**: 버튼과 설명을 섞은 형태로 — `pending_approval`은 설명 텍스트 + 승인/거부 버튼(`ApprovalCard`), `rejected`(하드 차단)는 버튼 없이 사유 설명만(`RejectedNotice`). 이 둘을 구분한 이유는 [[bosun-secure-findings]]의 "하드 경계는 협상 불가 / 나머지는 승인 게이트" 구분과 대응시키기 위함 — 실제 Secure 정책이 두 갈래이므로 UI도 두 갈래로 미리 분리해둠.
- **대기 상태 표시**: "생각 중"(`thinking`, 점 3개 애니메이션)과 "승인 대기중"(`pending_approval`, 카드+버튼)을 다른 컴포넌트로 분리 — 같은 대기라도 사용자가 취할 수 있는 행동이 다르기 때문(전자는 기다리기만, 후자는 승인/거부 결정 필요).
- **컴포넌트 조립 방식**: 오픈소스 채팅 UI 템플릿을 통째로 가져오는 대신, shadcn류 스타일로 작은 컴포넌트(`ApprovalCard`/`RejectedNotice`/`ChatMessageBubble`)를 직접 조립하는 방식을 선택 — 상태별 UI 분기가 프로젝트 고유 요구사항(Secure 승인/차단)이라 범용 템플릿보다 커스텀 조립이 맞다고 판단.

## 인터페이스 계약 (WEB ↔ AI Agent)

아키텍처 설계 문서 기준 `WEB - AI Agent : 메시지`. 현재 목업은 `AgentResult`(`reply` | `approval_required` | `rejected`) 판별 유니온으로 표현됨(`src/lib/mockAgent.ts`). 실제 연동 시 AI Agent·Secure 담당자와 다음을 확정해야 함:

- 이 판별 유니온이 실제 AI Agent/Secure 응답 스키마와 얼마나 맞는지 (특히 `approval_required`의 `details`가 실제 Secure의 위험 사유와 대응하는지)
- 스트리밍이 실제로 토큰 단위 스트림(SSE/WebSocket)인지, 완성된 문장 단위인지
- 승인/거부 결정을 WEB이 어떤 API로 다시 Secure에 전달하는지
- 세션/컨텍스트 유지 방식
