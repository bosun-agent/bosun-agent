// 대화 복원 응답(계약 3장)을 화면 메시지로 바꾼다.
// 처리 과정은 승인·차단 결과만 남는다. 도구 호출 줄은 서버가 보관하지 않는다.

import type { ChatMessage, ProcessStep } from '../types'
import type { ApprovalStatus, RestoredCard, RestoredMessage } from './agentProtocol'
import { withSummary } from './processSteps'

const APPROVAL_STEP: Record<Exclude<ApprovalStatus, 'pending'>, Pick<ProcessStep, 'label' | 'state'>> = {
  approved: { label: '승인함', state: 'done' },
  denied: { label: '거부함', state: 'stopped' },
  expired: { label: '승인 시간이 지나 취소됨', state: 'stopped' },
  cancelled: { label: '취소됨', state: 'stopped' },
}

function stepFor(card: RestoredCard): ProcessStep | undefined {
  const id = crypto.randomUUID()
  if (card.kind === 'rejected') return { id, label: '정책에 따라 차단됨', state: 'failed' }
  if (card.status === 'pending') return undefined
  const { label, state } = APPROVAL_STEP[card.status]
  return { id, label: withSummary(label, card.summary), state, detail: card.action.tool }
}

export function toChatMessages(restored: RestoredMessage[], now = Date.now()): ChatMessage[] {
  return restored.map((m): ChatMessage => {
    const id = crypto.randomUUID()
    if (m.role === 'user') return { id, role: 'user', content: m.content, status: 'done' }

    const cards = m.cards ?? []
    const steps = cards.map(stepFor).filter((s): s is ProcessStep => s !== undefined)
    const base: ChatMessage = { id, role: 'assistant', content: m.content, status: 'done', ...(steps.length ? { steps } : {}) }

    const rejected = cards.find((c) => c.kind === 'rejected')
    if (rejected) base.rejectionReason = rejected.reason

    // 아직 결정하지 않은 카드는 다시 띄운다. 시간이 지났으면 만료로 보여준다(서버가 이미 거부했다).
    const pending = cards.find((c) => c.kind === 'approval' && c.status === 'pending')
    if (pending?.kind === 'approval') {
      const { approvalId, summary, action, reasons, risk, expiresAt } = pending
      const live = Date.parse(expiresAt) > now
      return {
        ...base,
        status: live ? 'pending_approval' : 'approval_expired',
        approval: { approvalId, summary, action, reasons, ...(risk ? { risk } : {}), expiresAt },
        steps: [
          ...steps,
          {
            id: crypto.randomUUID(),
            label: withSummary(live ? '사용자 승인 기다리는 중' : '승인 시간이 지나 취소됨', summary),
            state: live ? 'active' : 'stopped',
          },
        ],
      }
    }
    return base
  })
}
