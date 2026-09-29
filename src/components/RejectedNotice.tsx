export function RejectedNotice({ reason }: { reason: string }) {
  return (
    <div className="max-w-[85%] rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-[15px] text-red-900">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-red-700">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" />
        차단됨
      </div>
      <p>{reason}</p>
    </div>
  )
}
