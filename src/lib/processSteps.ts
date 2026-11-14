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

// 차단 사유 목록에 하나를 더한다. 같은 사유가 되풀이되면(모델이 같은 실수를 반복) 한 번만 둔다.
export function addDetail(details: string[] | undefined, detail: string | undefined): string[] | undefined {
  if (!detail || details?.includes(detail)) return details
  return [...(details ?? []), detail]
}

export const APPROVED_LABEL = '승인함'
// 승인 방식에 따라 WEB이 카드 없이 대신 승인했다(auto_approved).
export const AUTO_APPROVED_LABEL = '자동 승인함'
export const CANCELLED_LABEL = '취소됨'
export const BLOCKED_LABEL = '정책에 따라 차단됨'
export const CHANGED_LABEL = '대상이 바뀌어 실행 안 함'

// 승인했지만 카드가 뜬 뒤 다른 대화가 같은 대상을 바꿔서 WEB이 실행하지 않았다(rejected TARGET_CHANGED).
// 그 카드의 "승인함: X"(복원하면 "취소됨: X") 줄을 이 줄로 바꾼다. 승인함으로 남으면 실행된 것처럼 보인다.
export function markTargetChanged(steps: ProcessStep[], summary: string | undefined): ProcessStep[] {
  const label = withSummary(CHANGED_LABEL, summary)
  const decided = [APPROVED_LABEL, CANCELLED_LABEL].map((l) => withSummary(l, summary))
  const i = steps.findLastIndex((s) => s.state !== 'active' && decided.includes(s.label))
  if (i < 0) return [...steps, { id: crypto.randomUUID(), label, state: 'stopped' }]
  return steps.map((s, j) => (j === i ? { ...s, label, state: 'stopped' } : s))
}

// 마지막 차단 뒤에 승인한 작업이 있다. 모델이 막힌 요청을 고쳐서 다시 해냈을 가능성이 커서
// 차단 안내를 빨간 경고 대신 회색 안내로 낮춘다(2026-10-28 리허설: 생성 body가 빠져 두 번 막힌 뒤 생성·시작 성공).
// 조회처럼 승인 없이 이어진 단계만으로는 낮추지 않는다. 막힌 요청을 포기하고 다른 걸 조회했을 수 있어서다.
export function blockResolved(steps: ProcessStep[]): boolean {
  const lastBlock = steps.findLastIndex((s) => s.state === 'failed' && s.label.startsWith(BLOCKED_LABEL))
  if (lastBlock < 0) return false
  return steps
    .slice(lastBlock + 1)
    .some((s) => s.state === 'done' && (s.label.startsWith(APPROVED_LABEL) || s.label.startsWith(AUTO_APPROVED_LABEL)))
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
