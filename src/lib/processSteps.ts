// 처리 과정 목록을 다루는 순수 함수. 진행 중인 단계는 항상 하나 이하로 유지한다.

import type { ProcessStep, StepState } from '../types'

type NewStep = Pick<ProcessStep, 'label' | 'doneLabel' | 'detail'>

// 진행 중인 단계를 끝내고 새 단계를 진행 중으로 붙인다.
export function startStep(steps: ProcessStep[], step: NewStep): ProcessStep[] {
  return [
    ...finishActive(steps, 'done'),
    { ...step, id: crypto.randomUUID(), state: 'active' },
  ]
}

// 진행 중인 단계를 주어진 상태로 끝낸다. label을 주면 그 문구로 바꾼다.
export function finishActive(
  steps: ProcessStep[],
  state: Exclude<StepState, 'active'>,
  label?: string,
): ProcessStep[] {
  return steps.map((s) => {
    if (s.state !== 'active') return s
    const fallback = state === 'done' ? (s.doneLabel ?? s.label) : s.label
    return { ...s, state, label: label ?? fallback }
  })
}

export function hasActive(steps: ProcessStep[]) {
  return steps.some((s) => s.state === 'active')
}
