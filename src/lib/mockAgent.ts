// AI Agent 파트가 준비되기 전까지 쓰는 목업.
// 실제 연동 시에는 이 파일의 askAgent()만 실제 API/WebSocket 호출로 교체하면 된다.
// 세 가지 결과 타입은 Secure 계층의 실제 정책(하드 차단 / 승인 필요 / 자동 진행)을 그대로 흉내낸다.

export type AgentResult =
  | { type: 'reply'; text: string }
  | { type: 'approval_required'; summary: string; details: string[] }
  | { type: 'rejected'; reason: string }

const HARD_BLOCK_SCOPE = ['전체', '모두', '모든']
const DESTRUCTIVE = ['삭제', '지워', '제거', '날려', '중지', '재시작']
const SITE_KEYWORDS = ['웹사이트', '웹 서버', 'nginx']
const STATUS_KEYWORDS = ['목록', '뭐가 떠', '상태', '조회']

function classify(text: string): AgentResult {
  const isDestructive = DESTRUCTIVE.some((kw) => text.includes(kw))
  const isBroadScope = HARD_BLOCK_SCOPE.some((kw) => text.includes(kw))

  if (isDestructive && isBroadScope) {
    return {
      type: 'rejected',
      reason:
        '전체/일괄 삭제처럼 되돌릴 수 없는 대량 작업은 이 채팅 경로에서 항상 차단돼요. 필요하시면 Portainer 대시보드에서 직접 진행해주세요.',
    }
  }

  if (isDestructive) {
    return {
      type: 'approval_required',
      summary: '요청하신 작업은 되돌리기 어려운 변경이라 승인이 필요해요.',
      details: [
        '대상 리소스와 옵션을 다시 한번 확인해주세요.',
        '승인하시면 바로 실행하고, 거부하시면 취소돼요.',
      ],
    }
  }

  if (SITE_KEYWORDS.some((kw) => text.includes(kw))) {
    return {
      type: 'reply',
      text: '웹 서버(nginx) 컨테이너를 생성할게요. 외부 포트는 8080으로 열까요? 확인해주시면 진행하겠습니다.',
    }
  }

  if (STATUS_KEYWORDS.some((kw) => text.includes(kw))) {
    return {
      type: 'reply',
      text: '현재 실행 중인 컨테이너 목록을 불러오는 중이에요. (목업 응답)',
    }
  }

  return {
    type: 'reply',
    text: `"${text}" 요청을 이해했어요. (아직 AI Agent 연동 전이라 목업 응답입니다.)`,
  }
}

export function askAgent(userText: string): Promise<AgentResult> {
  const delay = 500 + Math.random() * 700
  return new Promise((resolve) => {
    setTimeout(() => resolve(classify(userText)), delay)
  })
}
