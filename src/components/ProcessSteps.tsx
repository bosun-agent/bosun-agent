import { useState } from 'react'
import type { ProcessStep, StepState } from '../types'

const STATE_STYLE: Record<StepState, string> = {
  active: 'text-neutral-700',
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

  if (!live && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mb-1 text-xs text-neutral-400 hover:text-neutral-600"
      >
        처리 과정 보기 · {steps.length}단계
      </button>
    )
  }

  return (
    <div className="mb-1.5">
      <ol className="space-y-0.5 text-xs">
        {steps.map((step) => (
          <li
            key={step.id}
            className={`flex items-center gap-1.5 ${STATE_STYLE[step.state]}`}
          >
            <span className="inline-flex w-3 justify-center">
              {step.state === 'active' ? (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-500" />
              ) : (
                STATE_ICON[step.state]
              )}
            </span>
            <span>{step.label}</span>
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
          className="mt-1 text-xs text-neutral-400 hover:text-neutral-600"
        >
          접기
        </button>
      )}
    </div>
  )
}
