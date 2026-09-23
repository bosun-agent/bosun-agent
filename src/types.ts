export type ChatRole = 'user' | 'assistant'

export type MessageStatus =
  | 'done'
  | 'thinking'
  | 'streaming'
  | 'pending_approval'
  | 'rejected'

export interface ApprovalRequest {
  summary: string
  details: string[]
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  status: MessageStatus
  approval?: ApprovalRequest
  rejectionReason?: string
}
