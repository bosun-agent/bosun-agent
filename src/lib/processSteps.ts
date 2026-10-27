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

// 도구 단계는 호출 ID로 짝짓는다. 모델이 도구를 한꺼번에 여러 개 부르면 진행 중인 도구 단계가 여럿일 수 있다.
// 새 도구 단계를 붙일 때는 도구가 아닌 진행 단계(요청 이해 등)만 끝낸다.
export function startToolStep(steps: ProcessStep[], step: NewStep, callId: string): ProcessStep[] {
  return [
    ...steps.map((s) =>
      s.state === 'active' && !s.callId ? { ...s, state: 'done' as const, label: s.doneLabel ?? s.label } : s,
    ),
    { ...step, id: crypto.randomUUID(), callId, state: 'active' },
  ]
}

// 같은 호출 ID의 단계를 끝낸다. 그런 단계가 없으면(거부·차단된 호출) null.
export function finishToolStep(
  steps: ProcessStep[],
  callId: string,
  state: Exclude<StepState, 'active'>,
  label: string,
): ProcessStep[] | null {
  if (!steps.some((s) => s.callId === callId)) return null
  return steps.map((s) => (s.callId === callId ? { ...s, state, label } : s))
}

export function hasActive(steps: ProcessStep[]) {
  return steps.some((s) => s.state === 'active')
}

// "승인함: 컨테이너 web 재시작"처럼 무엇을 결정했는지 붙인다. 카드가 연달아 뜨면 무엇을 승인했는지 놓치기 쉽다(2026-10-28 리허설).
export function withSummary(label: string, summary: string | undefined): string {
  return summary ? `${label}: ${summary}` : label
}

// 연달아 같은 결과가 나온 단계(정책에 따라 차단됨 ×4 등)를 한 줄로 묶는다. 진행 중인 단계는 묶지 않는다.
export function groupSteps(steps: ProcessStep[]): { step: ProcessStep; count: number }[] {
  const groups: { step: ProcessStep; count: number }[] = []
  for (const step of steps) {
    const prev = groups.at(-1)
    const same =
      prev &&
      prev.step.state !== 'active' &&
      step.state !== 'active' &&
      prev.step.label === step.label &&
      prev.step.state === step.state &&
      prev.step.detail === step.detail
    if (same) prev.count++
    else groups.push({ step, count: 1 })
  }
  return groups
}
