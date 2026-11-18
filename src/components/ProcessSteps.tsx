import { useState } from 'react'
import { AUTO_APPROVED_LABEL, groupSteps } from '../lib/processSteps'
import type { ProcessStep, StepCard, StepState } from '../types'

const STATE_STYLE: Record<StepState, string> = {
  active: 'text-neutral-800',
  done: 'text-neutral-500',
  failed: 'text-red-600',
  stopped: 'text-neutral-400',
}

const STATE_ICON: Record<StepState, string> = {
  active: '',
  done: '✓',
  failed: '✕',
  stopped: '–',
}

interface ProcessStepsProps {
  steps: ProcessStep[]
  // 처리 중이면 펼쳐서 실시간으로 보여주고, 끝나면 "처리 과정 보기"로 접는다.
  live: boolean
}

// 결정한 카드를 읽기 전용으로 다시 보여 준다. 승인·거부 버튼은 없다.
function StepCardView({ card }: { card: StepCard }) {
  const params = Object.entries(card.action.params ?? {})
  return (
    <div className="mt-1 mb-1.5 ml-4.5 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-700">
      <p className="font-medium text-neutral-900">
        {card.summary}
        {card.risk && <span className="ml-2 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-normal text-neutral-600">{card.risk.label}</span>}
      </p>
      {card.reasons.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {card.reasons.map((r, i) => (
            <li key={i}>{r.message}</li>
          ))}
        </ul>
      )}
      {(card.action.target || params.length > 0) && (
        <dl className="mt-1.5 grid grid-cols-[5rem_1fr] gap-y-0.5">
          {card.action.target && (
            <>
              <dt className="text-neutral-500">대상</dt>
              <dd className="font-mono break-all">{card.action.target}</dd>
            </>
          )}
          {params.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-neutral-500">{k}</dt>
              <dd className="font-mono break-all">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

export function ProcessSteps({ steps, live }: ProcessStepsProps) {
  const [expanded, setExpanded] = useState(false)
  const [openCard, setOpenCard] = useState<string | null>(null)

  if (steps.length === 0) return null
  const groups = groupSteps(steps)

  // 승인 없이 실행한 작업은 접혀 있어도 보이게 한다(승인 방식이 묻지 않는 경우).
  const autoCount = steps.filter((s) => s.label.startsWith(AUTO_APPROVED_LABEL)).length

  if (!live && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mb-1 text-xs text-neutral-500 hover:text-neutral-600"
      >
        처리 과정 보기 · {groups.length}단계
        {autoCount > 0 && <span className="ml-1 font-medium text-amber-700">· 자동 승인 {autoCount}건</span>}
      </button>
    )
  }

  return (
    <div className="mb-1.5">
      <ol className="space-y-1 text-[13px]">
        {groups.map(({ step, count }) => {
          // 끝난 승인 줄만 다시 펼친다. 기다리는 중인 카드는 아래에 진짜 카드로 떠 있다.
          const card = step.state !== 'active' ? step.card : undefined
          const open = card && openCard === step.id
          return (
            <li key={step.id} className={STATE_STYLE[step.state]}>
              <div className="flex items-center gap-1.5">
                <span className="inline-flex w-3 justify-center">
                  {step.state === 'active' ? (
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-navy-600" />
                  ) : (
                    STATE_ICON[step.state]
                  )}
                </span>
                {card ? (
                  <button
                    type="button"
                    onClick={() => setOpenCard((o) => (o === step.id ? null : step.id))}
                    aria-expanded={!!open}
                    title="이때 본 승인 카드 다시 보기"
                    className="text-left hover:underline"
                  >
                    {step.label}
                    {count > 1 && <span className="ml-1 tabular-nums">×{count}</span>}
                    <span className="ml-1 text-[10px] text-neutral-400">{open ? '▾' : '▸'}</span>
                  </button>
                ) : (
                  <span>
                    {step.label}
                    {count > 1 && <span className="ml-1 tabular-nums">×{count}</span>}
                  </span>
                )}
                {step.detail && <span className="font-mono text-[11px] text-neutral-400">{step.detail}</span>}
              </div>
              {open && card && <StepCardView card={card} />}
            </li>
          )
        })}
      </ol>
      {!live && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-1 text-xs text-neutral-500 hover:text-neutral-600"
        >
          접기
        </button>
      )}
    </div>
  )
}
