import { useState } from 'react'
import { AUTO_APPROVED_LABEL, groupSteps } from '../lib/processSteps'
import type { ProcessStep, StepState } from '../types'

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

export function ProcessSteps({ steps, live }: ProcessStepsProps) {
  const [expanded, setExpanded] = useState(false)

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
        {groups.map(({ step, count }) => (
          <li
            key={step.id}
            className={`flex items-center gap-1.5 ${STATE_STYLE[step.state]}`}
          >
            <span className="inline-flex w-3 justify-center">
              {step.state === 'active' ? (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-navy-600" />
              ) : (
                STATE_ICON[step.state]
              )}
            </span>
            <span>
              {step.label}
              {count > 1 && <span className="ml-1 tabular-nums">×{count}</span>}
            </span>
            {step.detail && (
              <span className="font-mono text-[11px] text-neutral-400">
                {step.detail}
              </span>
            )}
          </li>
        ))}
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
