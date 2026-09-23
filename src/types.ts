import type { ProposedAction, RiskReason } from './lib/agentProtocol'

export type ChatRole = 'user' | 'assistant'

export type MessageStatus =
  | 'done'
  | 'thinking'
  | 'streaming'
  | 'pending_approval'
  | 'rejected'
  | 'error'

export interface ApprovalRequest {
  approvalId: string
  summary: string
  action: ProposedAction
  reasons: RiskReason[]
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  status: MessageStatus
  approval?: ApprovalRequest
  rejectionReason?: string
  errorMessage?: string
  // 도구 실행 진행 상황 한 줄(tool_status 이벤트)
  toolStatus?: string
}
