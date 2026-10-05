import type { ProposedAction, RiskReason } from './lib/agentProtocol'

export type ChatRole = 'user' | 'assistant'

export type MessageStatus =
  | 'done'
  | 'thinking'
  | 'streaming'
  | 'pending_approval'
  | 'approval_expired'
  | 'rejected'
  | 'error'

export interface ApprovalRequest {
  approvalId: string
  summary: string
  action: ProposedAction
  reasons: RiskReason[]
  expiresAt: string
}

// stopped: 거부·만료처럼 실패는 아니지만 진행하지 않은 단계
export type StepState = 'active' | 'done' | 'failed' | 'stopped'

// 처리 과정 한 줄. 도구 인자는 담지 않는다(인터페이스 계약 5장 4항).
export interface ProcessStep {
  id: string
  label: string
  // 다음 단계가 시작돼 자동으로 끝날 때 바꿔 쓸 문구
  doneLabel?: string
  // 도구 이름
  detail?: string
  state: StepState
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  status: MessageStatus
  approval?: ApprovalRequest
  rejectionReason?: string
  errorMessage?: string
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
}
