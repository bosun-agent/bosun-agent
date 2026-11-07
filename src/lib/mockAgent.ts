// AI Agent 파트가 준비되기 전까지 쓰는 목업.
// agentProtocol.ts의 이벤트 스트림을 그대로 흉내낸다. 실제 연동 시에는
// 같은 AgentClient 인터페이스를 SSE로 구현한 클라이언트로 교체하면 된다.

import type { AgentClient, AgentEvent } from './agentProtocol'

const HARD_BLOCK_SCOPE = ['전체', '모두', '모든']
const DESTRUCTIVE = ['삭제', '지워', '제거', '날려', '중지', '재시작']
const SITE_KEYWORDS = ['웹사이트', '웹 서버', 'nginx']
const STATUS_KEYWORDS = ['목록', '뭐가 떠', '상태', '조회']

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// 개발 모드에서 화면 상태를 하나씩 재현하기 위한 시나리오. DevScenarioBar가 버튼으로 보여준다.
export const DEV_SCENARIOS = [
  { command: '/reply', label: '일반 응답' },
  { command: '/slow', label: '오래 생각' },
  { command: '/approval', label: '승인 대기' },
  { command: '/approval-fail', label: '승인 후 실행 실패' },
  { command: '/expired', label: '만료된 승인' },
  { command: '/expiring', label: '10초 뒤 만료' },
  { command: '/reject', label: '하드 차단' },
  { command: '/error', label: '시스템 오류' },
  { command: '/disconnect', label: '연결 끊김' },
] as const

interface PendingApproval {
  sessionId: string
  tool: string
  willFail: boolean
}

// 서버가 들고 있을 승인 대기 목록. 1회용이라 처리되면 지운다.
const pendingApprovals = new Map<string, PendingApproval>()

function approvalEvent(
  sessionId: string,
  { willFail = false, store = true, ttlMs = 5 * 60_000 } = {},
): AgentEvent {
  const approvalId = `ap_${crypto.randomUUID().slice(0, 8)}`
  const tool = 'docker_proxy'
  // store=false면 발급만 하고 서버에 없는 상태 → 승인 시 만료 오류(409)를 재현
  if (store) pendingApprovals.set(approvalId, { sessionId, tool, willFail })
  // 실제 백엔드(server/tools.ts)가 컨테이너 삭제 요청으로 만드는 카드와 같은 모양
  return {
    type: 'approval_required',
    approvalId,
    summary: '컨테이너 nginx-web 삭제',
    action: { tool, target: 'nginx-web', params: { 요청: 'DELETE /containers/nginx-web' } },
    reasons: [
      { code: 'EFFECT', message: '컨테이너와 그 안에서 바뀐 파일이 지워져요. 이름 있는 볼륨은 남아요.' },
      { code: 'DESTRUCTIVE', message: '삭제하면 되돌릴 수 없어요.' },
    ],
    risk: { level: 'high', label: '되돌릴 수 없음' },
    // 기본값은 WEB 백엔드 승인 대기 시간(APPROVAL_TIMEOUT_MS) 기본값 5분
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  }
}

// Docker Agent는 도구를 실행하기 전에 승인을 묻는다. 호출 표시(tool_status running)는 승인 뒤에 온다.
async function* requestApproval(
  sessionId: string,
  options?: Parameters<typeof approvalEvent>[1],
): AsyncGenerator<AgentEvent> {
  await wait(400)
  yield* streamText('nginx-web 컨테이너를 삭제할게요.')
  yield approvalEvent(sessionId, options)
}

const BATCH_REJECTED: AgentEvent = {
  type: 'rejected',
  code: 'BATCH_DESTRUCTIVE',
  reason:
    '전체/일괄 삭제처럼 되돌릴 수 없는 대량 작업은 이 채팅 경로에서 항상 차단돼요. 필요하시면 Portainer 대시보드에서 직접 진행해주세요.',
}

async function* streamText(text: string): AsyncGenerator<AgentEvent> {
  const words = text.split(' ')
  for (let i = 0; i < words.length; i++) {
    await wait(45)
    yield { type: 'text_delta', delta: i === 0 ? words[i] : ` ${words[i]}` }
  }
}

async function* runScenario(
  sessionId: string,
  command: string,
): AsyncGenerator<AgentEvent> {
  switch (command) {
    case '/slow':
      await wait(4000)
      yield* streamText('오래 걸리는 작업을 마쳤어요. (목업 응답)')
      break
    case '/approval':
      yield* requestApproval(sessionId)
      return
    case '/approval-fail':
      yield* requestApproval(sessionId, { willFail: true })
      return
    case '/expired':
      yield* requestApproval(sessionId, { store: false })
      return
    case '/expiring':
      yield* requestApproval(sessionId, { ttlMs: 10_000 })
      return
    case '/reject':
      yield BATCH_REJECTED
      break
    case '/error':
      yield {
        type: 'error',
        code: 'PORTAINER_UNREACHABLE',
        message: 'Portainer에 연결할 수 없어요. 잠시 후 다시 시도해주세요.',
      }
      return
    case '/disconnect':
      yield* streamText('응답을 보내던 중에')
      throw new Error('stream disconnected')
    default:
      yield* streamText(
        '실행 중인 컨테이너는 3개예요: nginx-web, postgres-db, redis-cache. (목업 응답)',
      )
  }
  yield { type: 'done' }
}

async function* sendMessage(
  sessionId: string,
  text: string,
): AsyncGenerator<AgentEvent> {
  // Docker Agent는 실행을 시작할 때 도구 목록을 불러온 뒤 모델을 부른다.
  yield { type: 'progress', step: 'loading_tools' }
  await wait(300)
  yield { type: 'progress', step: 'understanding' }
  await wait(500 + Math.random() * 700)

  if (text.startsWith('/')) {
    yield* runScenario(sessionId, text.trim())
    return
  }

  const isDestructive = DESTRUCTIVE.some((kw) => text.includes(kw))
  const isBroadScope = HARD_BLOCK_SCOPE.some((kw) => text.includes(kw))

  if (isDestructive && isBroadScope) {
    yield BATCH_REJECTED
    yield { type: 'done' }
    return
  }

  if (isDestructive) {
    yield* requestApproval(sessionId)
    return
  }

  if (SITE_KEYWORDS.some((kw) => text.includes(kw))) {
    yield* streamText(
      '웹 서버(nginx) 컨테이너를 생성할게요. 외부 포트는 8080으로 열까요? 확인해주시면 진행하겠습니다.',
    )
  } else if (STATUS_KEYWORDS.some((kw) => text.includes(kw))) {
    // 조회는 승인 없이 바로 실행된다.
    yield {
      type: 'tool_status',
      tool: 'docker_proxy',
      status: 'running',
      summary: '도구 호출하는 중',
    }
    await wait(600)
    yield {
      type: 'tool_status',
      tool: 'docker_proxy',
      status: 'succeeded',
      summary: '조회 완료',
    }
    yield* streamText(
      '실행 중인 컨테이너는 3개예요: nginx-web, postgres-db, redis-cache. (목업 응답)',
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
    summary: '도구 호출하는 중',
  }
  await wait(600)
  if (pending.willFail) {
    yield {
      type: 'tool_status',
      tool: pending.tool,
      status: 'failed',
      summary: '실행 실패: 컨테이너가 사용 중이에요',
    }
    yield* streamText(
      '컨테이너가 아직 실행 중이라 삭제하지 못했어요. 먼저 중지할까요? (목업 응답)',
    )
    yield { type: 'done' }
    return
  }
  yield {
    type: 'tool_status',
    tool: pending.tool,
    status: 'succeeded',
    summary: '실행 완료',
  }
  yield* streamText('\n\nnginx-web 컨테이너를 삭제했어요. (목업 응답)')
  yield { type: 'done' }
}

// 멈추기. 다음 이벤트를 내보내기 전에 확인하고 error(STOPPED)로 끝낸다. 기다리던 승인도 버린다.
const stopRequests = new Set<string>()

async function* stoppable(sessionId: string, events: AsyncGenerator<AgentEvent>): AsyncGenerator<AgentEvent> {
  stopRequests.delete(sessionId)
  for await (const event of events) {
    if (stopRequests.delete(sessionId)) {
      yield { type: 'error', code: 'STOPPED', message: '작업을 멈췄어요.' }
      return
    }
    yield event
  }
}

// 목업 설정. 화면을 확인하는 용도라 새로고침하면 처음 값으로 돌아간다.
const MOCK_MODELS = ['openrouter/deepseek/deepseek-v4.1-flash', 'openrouter/deepseek/deepseek-v4.1']
let mockModel = MOCK_MODELS[0]
let mockKeySet = false
const customModels: string[] = []
const mockSettings = () => ({
  model: mockModel,
  models: [...MOCK_MODELS, ...customModels],
  customModels: [...customModels],
  apiKey: { editable: true, set: mockKeySet },
  // 목업은 카드를 대신 승인하지 않는다. 승인 방식은 WEB 백엔드에 붙여야 바꿀 수 있다.
  approvalMode: 'ask' as const,
  portainerUrl: 'https://localhost:9443',
})

export const mockAgent: AgentClient = {
  createSession: async () => `s_${crypto.randomUUID().slice(0, 8)}`,
  sendMessage: (sessionId, text) => stoppable(sessionId, sendMessage(sessionId, text)),
  sendDecision: (sessionId, approvalId, decision) => stoppable(sessionId, sendDecision(sessionId, approvalId, decision)),
  stop: async (sessionId) => {
    stopRequests.add(sessionId)
    for (const [id, p] of pendingApprovals) if (p.sessionId === sessionId) pendingApprovals.delete(id)
  },
  getSettings: async () => mockSettings(),
  saveModel: async (model) => {
    mockModel = model
    return mockSettings()
  },
  addModel: async (model) => {
    if (!mockSettings().models.includes(model)) customModels.push(model)
    return mockSettings()
  },
  removeModel: async (model) => {
    const i = customModels.indexOf(model)
    if (i >= 0) customModels.splice(i, 1)
    if (mockModel === model) mockModel = MOCK_MODELS[0]
    return mockSettings()
  },
  saveApiKey: async () => {
    mockKeySet = true
    return mockSettings()
  },
}
