import { useEffect, useState } from 'react'
import type { ApprovalRequest } from '../types'

interface ApprovalCardProps {
  approval: ApprovalRequest
  expired: boolean
  onApprove: () => void
  onDeny: () => void
  onExpire: () => void
}

// 남은 시간이 이보다 적으면 강조한다.
const URGENT_MS = 60_000

export function ApprovalCard({
  approval,
  expired,
  onApprove,
  onDeny,
  onExpire,
}: ApprovalCardProps) {
  const { summary, action, reasons, expiresAt } = approval
  const remainingMs = useRemainingMs(expiresAt, expired)

  useEffect(() => {
    if (!expired && remainingMs <= 0) onExpire()
  }, [expired, remainingMs, onExpire])

  if (expired) {
    return (
      <div className="max-w-[85%] rounded-2xl border border-neutral-300 bg-neutral-50 px-4 py-3 text-[15px] dark:border-neutral-700 dark:bg-neutral-900">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-neutral-400" />
          승인 시간이 지났어요
        </div>
        <p className="text-neutral-500 line-through dark:text-neutral-400">
          {summary}
        </p>
        <p className="mt-2 font-mono text-xs text-neutral-400">
          {action.tool}
          {action.target && ` → ${action.target}`}
        </p>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          실행되지 않았어요. 필요하면 다시 요청해주세요.
        </p>
      </div>
    )
  }

  const urgent = remainingMs <= URGENT_MS

  return (
    <div className="max-w-[85%] rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-[15px] dark:border-amber-700/60 dark:bg-amber-950/40">
      <div className="mb-1 flex items-center justify-between gap-3 text-xs font-medium">
        <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
          승인이 필요해요
        </span>
        <span
          className={`tabular-nums ${
            urgent
              ? 'text-red-600 dark:text-red-400'
              : 'text-neutral-500 dark:text-neutral-400'
          }`}
        >
          {formatRemaining(remainingMs)} 남음
        </span>
      </div>
      <p className="text-neutral-900 dark:text-neutral-100">{summary}</p>
      <p className="mt-2 font-mono text-xs text-neutral-500 dark:text-neutral-400">
        {action.tool}
        {action.target && ` → ${action.target}`}
      </p>
      {reasons.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm text-neutral-600 dark:text-neutral-400">
          {reasons.map((reason) => (
            <li key={reason.code}>· {reason.message}</li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onApprove}
          className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
        >
          승인
        </button>
        <button
          type="button"
          onClick={onDeny}
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 dark:border-neutral-600 dark:text-neutral-300"
        >
          거부
        </button>
      </div>
    </div>
  )
}

// expiresAt까지 남은 시간을 1초마다 다시 계산한다. 만료된 카드는 타이머를 돌리지 않는다.
function useRemainingMs(expiresAt: string, stopped: boolean) {
  const deadline = Date.parse(expiresAt)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (stopped) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [stopped])

  return Math.max(0, deadline - now)
}

function formatRemaining(ms: number) {
  const totalSeconds = Math.ceil(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
