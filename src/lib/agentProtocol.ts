// WEB ↔ AI Agent 인터페이스 타입. docs/interface-web-agent.md(v0.1)의 4장과 1:1로 맞춘다.
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

export type AgentEvent =
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
      expiresAt?: string
    }
  | { type: 'rejected'; code: string; reason: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' }

export type ApprovalDecision = 'approve' | 'deny'

// 실제 클라이언트도 이 모양을 구현하면 App.tsx는 바꿀 필요가 없다.
export interface AgentClient {
  createSession(): Promise<string>
  sendMessage(sessionId: string, text: string): AsyncIterable<AgentEvent>
  sendDecision(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): AsyncIterable<AgentEvent>
}
