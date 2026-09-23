interface ApprovalCardProps {
  summary: string
  details: string[]
  onApprove: () => void
  onDeny: () => void
}

export function ApprovalCard({
  summary,
  details,
  onApprove,
  onDeny,
}: ApprovalCardProps) {
  return (
    <div className="max-w-[85%] rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-[15px] dark:border-amber-700/60 dark:bg-amber-950/40">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
        승인이 필요해요
      </div>
      <p className="text-neutral-900 dark:text-neutral-100">{summary}</p>
      {details.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm text-neutral-600 dark:text-neutral-400">
          {details.map((detail) => (
            <li key={detail}>· {detail}</li>
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
