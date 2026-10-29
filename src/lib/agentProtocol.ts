// WEB ↔ AI Agent 인터페이스 타입. docs/interface-web-agent.md(v0.5.1)의 3·4장과 1:1로 맞춘다.
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

// 승인 카드 맨 위에 붙는 한눈에 보는 위험도(계약 4.1). high: 되돌릴 수 없거나 호스트까지 영향,
// medium: 서비스가 멈추거나 끊김, low: 새로 만들거나 실행, unknown: WEB이 모르는 도구라 판단할 수 없음.
export interface RiskLevel {
  level: 'high' | 'medium' | 'low' | 'unknown'
  label: string
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
      // 도구 호출 ID. 모델이 도구를 한꺼번에 여러 개 부르면 시작·결과를 이걸로 짝짓는다(계약 4.1)
      callId?: string
    }
  | {
      type: 'approval_required'
      approvalId: string
      summary: string
      action: ProposedAction
      reasons: RiskReason[]
      risk?: RiskLevel
      expiresAt: string
    }
  // detail: 무엇이 왜 막혔는지 한 줄(훅이 준 사유의 첫 문장). 사유가 없는 차단에는 없다(계약 4장).
  | { type: 'rejected'; code: string; reason: string; detail?: string }
  // 다시 붙기(GET .../stream)에서만 온다. 앞에 보낸 approval_required가 이미 결정됐다(계약 4장).
  | { type: 'approval_resolved'; approvalId: string; status: Exclude<ApprovalStatus, 'pending'> }
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
      risk?: RiskLevel
      expiresAt: string
    }
  | { kind: 'rejected'; code: string; reason: string; detail?: string }

export type RestoredMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; cards?: RestoredCard[] }

export interface SessionSummary {
  sessionId: string
  title: string
  updatedAt: string
  // WEB 백엔드가 이 대화를 처리하고 있다(승인 대기 포함). 화면은 다시 붙어서 받는다(GET .../stream).
  running?: boolean
  pinned?: boolean
  inputTokens?: number
  outputTokens?: number
}

// 실제 클라이언트도 이 모양을 구현하면 App.tsx는 바꿀 필요가 없다.
// 목록·복원은 서버가 있어야 하므로 목업에는 없다.
// 설정 화면 값(계약 3장). model이 null이면 agent.yaml에 적힌 모델을 쓴다.
// apiKey는 키 값 없이 상태만 준다. editable이 false면 WEB 백엔드에 Agent env 파일 경로가 없다.
export interface Settings {
  model: string | null
  models: string[]
  // models 중 관리자가 화면에서 더한 것. 이것만 지울 수 있다.
  customModels: string[]
  apiKey: { editable: boolean; set: boolean }
  // 정책 차단 안내의 "Portainer 열기" 링크. WEB 백엔드에 PORTAINER_URL이 없으면 빠진다.
  portainerUrl?: string
}

// 설정의 정보·정책 화면(계약 3장 GET /api/system). agent.yaml에서 고른 값만 온다.
export interface AgentConfigSummary {
  agents: {
    name: string
    description?: string
    model?: string
    safety?: string
    maxIterations?: number
    instruction?: string
    toolsets: { type: string; command?: string; args: string[]; tools: string[]; env: string[]; callTimeout?: string }[]
    hooks: { event: string; scripts: string[]; matchers: string[] }[]
  }[]
  models: { name: string; provider?: string; model?: string; maxTokens?: number }[]
  permissions: { allow: string[]; ask: string[]; deny: string[] }
}

export interface SystemInfo {
  web: { version: string; maxTurns: number; running: number; approvalTimeoutSec: number }
  agent: { name: string; reachable: boolean; version?: string; ready?: boolean; error?: string }
  config?: AgentConfigSummary
}

// 승인 기록 한 줄(GET /api/audit). 대화를 지웠으면 summary가 없다.
export interface AuditRecord {
  at: string
  user: string
  sessionId: string
  approvalId: string
  tool: string
  decision: ApprovalStatus
  summary?: string
  target?: string
}

// 삭제 전 백업 한 건(GET /api/backups). Agent 백업 훅이 저장한 inspect에서 고른 값만 온다.
export interface BackupRecord {
  id: number
  at: string
  sessionId: string
  environmentId: string
  // container | image | network
  kind: string
  target: string
  summary: Record<string, string>
  // 백업은 승인 전에 만들어져서 거부한 삭제도 남는다. 같은 대화의 승인 카드와 짝지은 결과(계약 3장).
  // deleted: 승인함, kept: 거부·만료·취소(지우지 않음), pending: 아직 결정 전, unknown: 짝을 찾지 못함
  outcome: 'deleted' | 'kept' | 'pending' | 'unknown'
}

// 대화 사용량(GET /api/sessions/{id}/usage). cost는 달러다.
export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cost?: number
}

// 전체 사용량(GET /api/usage). 턴마다 WEB이 기록한 값의 합이다. 대화를 지워도 남는다.
export interface UsageTotals {
  today: Required<SessionUsage>
  month: Required<SessionUsage>
  total: Required<SessionUsage>
}

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
  // running이면 그 턴의 답은 빠져 있다. attach로 다시 붙어서 받는다.
  loadMessages?(sessionId: string): Promise<{ messages: RestoredMessage[]; running: boolean }>
  // 처리 중인 턴에 다시 붙는다. 이 턴의 이벤트를 처음부터 받는다.
  attach?(sessionId: string): AsyncIterable<AgentEvent>
  // 처리를 멈춘다. 붙어 있는 스트림은 error(STOPPED)로 끝난다.
  stop?(sessionId: string): Promise<void>
  getSettings?(): Promise<Settings>
  saveModel?(model: string): Promise<Settings>
  addModel?(model: string): Promise<Settings>
  removeModel?(model: string): Promise<Settings>
  // 저장해도 Docker Agent를 다시 시작해야 적용된다(계약 7장 ①).
  saveApiKey?(apiKey: string): Promise<Settings>
  // 서버 대화 삭제. 처리 중인 대화는 서버가 409로 거절한다.
  deleteSession?(sessionId: string): Promise<void>
  renameSession?(sessionId: string, title: string): Promise<void>
  pinSession?(sessionId: string, pinned: boolean): Promise<void>
  // turn번째 사용자 메시지 직전까지 복사한 새 대화
  forkSession?(sessionId: string, turn: number): Promise<{ sessionId: string; title: string }>
  exportUrl?(sessionId: string): string
  getUsage?(sessionId: string): Promise<SessionUsage>
  getUsageTotals?(): Promise<UsageTotals>
  getSystem?(): Promise<SystemInfo>
  getToolCount?(): Promise<number>
  getAudit?(limit?: number): Promise<AuditRecord[]>
  // available: false면 WEB 백엔드에 백업 파일 위치가 없다(BACKUP_DB, AGENT_ENV_FILE).
  getBackups?(): Promise<{ available: boolean; records: BackupRecord[] }>
  // 실패하면 화면에 보여줄 문장을 준다.
  changePassword?(current: string, next: string): Promise<{ ok: true } | { ok: false; message: string }>
}
