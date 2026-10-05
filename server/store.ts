// WEB 고유 데이터: 승인·차단 카드와 승인 감사 기록(계약 7.1).
// 대화 내용은 Docker Agent session.db가 보관하므로 여기 두지 않는다.
// 지금은 메모리에만 둔다. 백엔드를 다시 켜면 사라지므로 SQLite로 옮기는 게 다음 작업이다.

import type { ProposedAction, RiskReason } from '../src/lib/agentProtocol.ts'

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled'

export type Card =
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

interface StoredCard {
  sessionId: string
  // 이 카드가 몇 번째 사용자 메시지(0부터)의 응답에 붙는지. 대화 복원 때 위치를 정한다.
  turn: number
  card: Card
}

export interface AuditEntry {
  at: string
  user: string
  sessionId: string
  approvalId: string
  airlockId: string
  tool: string
  decision: ApprovalStatus
}

const cards: StoredCard[] = []
const audit: AuditEntry[] = []

export function addCard(sessionId: string, turn: number, card: Card): void {
  cards.push({ sessionId, turn, card })
}

export function updateApprovalCard(approvalId: string, status: ApprovalStatus): void {
  for (const c of cards) {
    if (c.card.kind === 'approval' && c.card.approvalId === approvalId) c.card.status = status
  }
}

export function cardsFor(sessionId: string): StoredCard[] {
  return cards.filter((c) => c.sessionId === sessionId)
}

export function logDecision(entry: Omit<AuditEntry, 'at'>): void {
  const row = { at: new Date().toISOString(), ...entry }
  audit.push(row)
  console.info('[audit]', JSON.stringify(row))
}
