// WEB ↔ AI Agent 인터페이스 타입. docs/interface-web-agent.md(v0.2.12)의 3·4장과 1:1로 맞춘다.
// 목업(mockAgent.ts)과 실제 클라이언트가 모두 이 타입의 이벤트 스트림을 내보낸다.

export interface ProposedAction {
  tool: string
  target?: string
  params?: Record<string, unknown>
}

export interface RiskReason {
  code: string
  message: string
}

export type ProgressStep = 'loading_tools' | 'understanding'

export type AgentEvent =
  | { type: 'progress'; step: ProgressStep }
  | { type: 'text_delta'; delta: string }
  | {
      type: 'tool_status'
      tool: string
      status: 'running' | 'succeeded' | 'failed'
      summary: string
    }
  | {
      type: 'approval_required'
      approvalId: string
      summary: string
      action: ProposedAction
      reasons: RiskReason[]
      expiresAt: string
    }
  | { type: 'rejected'; code: string; reason: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' }

export type ApprovalDecision = 'approve' | 'deny'

// ---- 대화 목록과 복원(계약 3장) ----

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled'

export type RestoredCard =
  | {
      kind: 'approval'
      approvalId: string
      status: ApprovalStatus
      summary: string
      action: ProposedAction
      reasons: RiskReason[]
      expiresAt: string
    }
  | { kind: 'rejected'; code: string; reason: string }

export type RestoredMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; cards?: RestoredCard[] }

export interface SessionSummary {
  sessionId: string
  title: string
  updatedAt: string
}

// 실제 클라이언트도 이 모양을 구현하면 App.tsx는 바꿀 필요가 없다.
// 목록·복원은 서버가 있어야 하므로 목업에는 없다.
export interface AgentClient {
  createSession(): Promise<string>
  sendMessage(sessionId: string, text: string): AsyncIterable<AgentEvent>
  // reason: 승인 시간이 지나 브라우저가 거부를 보낼 때만 'expired'(계약 6장)
  sendDecision(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    reason?: 'expired',
  ): AsyncIterable<AgentEvent>
  listSessions?(): Promise<SessionSummary[]>
  loadMessages?(sessionId: string): Promise<RestoredMessage[]>
}
