import type { ProposedAction, RiskLevel, RiskReason } from './lib/agentProtocol'

export type ChatRole = 'user' | 'assistant'

export type MessageStatus =
  | 'done'
  | 'thinking'
  | 'streaming'
  | 'pending_approval'
  | 'approval_expired'
  | 'error'

export interface ApprovalRequest {
  approvalId: string
  summary: string
  action: ProposedAction
  reasons: RiskReason[]
  risk?: RiskLevel
  expiresAt: string
}

// stopped: 거부·만료처럼 실패는 아니지만 진행하지 않은 단계
export type StepState = 'active' | 'done' | 'failed' | 'stopped'

// 처리 과정 한 줄. 도구 인자는 담지 않는다.
export interface ProcessStep {
  id: string
  label: string
  // 다음 단계가 시작돼 자동으로 끝날 때 바꿔 쓸 문구
  doneLabel?: string
  // 도구 이름
  detail?: string
  // 도구 단계의 호출 ID(tool_status.callId)
  callId?: string
  state: StepState
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  status: MessageStatus
  approval?: ApprovalRequest
  // 이 턴에서 정책으로 막힌 호출이 있었다. 턴은 계속될 수 있으므로 상태와 따로 둔다(차단 안내 + 이어진 답).
  rejectionReason?: string
  // 막힌 호출마다 무엇이 왜 막혔는지(rejected.detail). 같은 사유는 한 번만 둔다.
  rejectionDetails?: string[]
  // 막힌 것 중 정책 차단(POLICY_DENIED)이 있다. 이때만 Portainer에서 직접 하라고 안내한다.
  policyBlocked?: boolean
  errorMessage?: string
  // 답 아래에 작게 붙는 안내(사용자가 멈춤 등)
  notice?: string
  steps?: ProcessStep[]
}

export interface ChatSession {
  // 브라우저 안에서 쓰는 id. 서버 세션은 첫 메시지를 보낼 때 만든다.
  id: string
  serverId?: string
  // 서버에서 목록만 받고 내용은 아직 안 불러온 대화면 false
  loaded?: boolean
  title: string
  messages: ChatMessage[]
  pinned?: boolean
  // 서버 대화 목록에서 받은 토큰 사용량
  inputTokens?: number
  outputTokens?: number
}
