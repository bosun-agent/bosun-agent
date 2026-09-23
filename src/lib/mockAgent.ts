// AI Agent 파트가 준비되기 전까지 쓰는 목업.
// docs/interface-web-agent.md의 이벤트 스트림을 그대로 흉내낸다. 실제 연동 시에는
// 같은 AgentClient 인터페이스를 SSE로 구현한 클라이언트로 교체하면 된다.

import type { AgentClient, AgentEvent } from './agentProtocol'

const HARD_BLOCK_SCOPE = ['전체', '모두', '모든']
const DESTRUCTIVE = ['삭제', '지워', '제거', '날려', '중지', '재시작']
const SITE_KEYWORDS = ['웹사이트', '웹 서버', 'nginx']
const STATUS_KEYWORDS = ['목록', '뭐가 떠', '상태', '조회']

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// 서버가 들고 있을 승인 대기 목록. 1회용이라 처리되면 지운다.
const pendingApprovals = new Map<string, { sessionId: string; tool: string }>()

async function* streamText(text: string): AsyncGenerator<AgentEvent> {
  const words = text.split(' ')
  for (let i = 0; i < words.length; i++) {
    await wait(45)
    yield { type: 'text_delta', delta: i === 0 ? words[i] : ` ${words[i]}` }
  }
}

async function* sendMessage(
  sessionId: string,
  text: string,
): AsyncGenerator<AgentEvent> {
  await wait(500 + Math.random() * 700)

  const isDestructive = DESTRUCTIVE.some((kw) => text.includes(kw))
  const isBroadScope = HARD_BLOCK_SCOPE.some((kw) => text.includes(kw))

  if (isDestructive && isBroadScope) {
    yield {
      type: 'rejected',
      code: 'BATCH_DESTRUCTIVE',
      reason:
        '전체/일괄 삭제처럼 되돌릴 수 없는 대량 작업은 이 채팅 경로에서 항상 차단돼요. 필요하시면 Portainer 대시보드에서 직접 진행해주세요.',
    }
    yield { type: 'done' }
    return
  }

  if (isDestructive) {
    const approvalId = `ap_${crypto.randomUUID().slice(0, 8)}`
    const tool = 'docker_container_remove'
    pendingApprovals.set(approvalId, { sessionId, tool })
    yield {
      type: 'approval_required',
      approvalId,
      summary: '요청하신 작업은 되돌리기 어려운 변경이라 승인이 필요해요.',
      action: { tool, target: 'nginx-web' },
      reasons: [
        { code: 'DESTRUCTIVE', message: '실행하면 되돌릴 수 없어요.' },
        {
          code: 'CONFIRM_TARGET',
          message: '대상 리소스와 옵션을 다시 한번 확인해주세요.',
        },
      ],
    }
    return
  }

  if (SITE_KEYWORDS.some((kw) => text.includes(kw))) {
    yield* streamText(
      '웹 서버(nginx) 컨테이너를 생성할게요. 외부 포트는 8080으로 열까요? 확인해주시면 진행하겠습니다.',
    )
  } else if (STATUS_KEYWORDS.some((kw) => text.includes(kw))) {
    yield* streamText(
      '현재 실행 중인 컨테이너 목록을 불러오는 중이에요. (목업 응답)',
    )
  } else {
    yield* streamText(
      `"${text}" 요청을 이해했어요. (아직 AI Agent 연동 전이라 목업 응답입니다.)`,
    )
  }
  yield { type: 'done' }
}

async function* sendDecision(
  sessionId: string,
  approvalId: string,
  decision: 'approve' | 'deny',
): AsyncGenerator<AgentEvent> {
  const pending = pendingApprovals.get(approvalId)
  if (!pending || pending.sessionId !== sessionId) {
    // 실제 서버에서는 409 응답에 해당
    yield {
      type: 'error',
      code: 'APPROVAL_NOT_FOUND',
      message: '이미 처리됐거나 만료된 승인 요청이에요.',
    }
    return
  }
  pendingApprovals.delete(approvalId)

  if (decision === 'deny') {
    yield* streamText('요청을 취소했어요.')
    yield { type: 'done' }
    return
  }

  yield {
    type: 'tool_status',
    tool: pending.tool,
    status: 'running',
    summary: '실행 중…',
  }
  await wait(600)
  yield {
    type: 'tool_status',
    tool: pending.tool,
    status: 'succeeded',
    summary: '실행 완료',
  }
  yield* streamText('승인해주셔서 진행했어요. (목업 응답)')
  yield { type: 'done' }
}

export const mockAgent: AgentClient = {
  createSession: async () => `s_${crypto.randomUUID().slice(0, 8)}`,
  sendMessage,
  sendDecision,
}
