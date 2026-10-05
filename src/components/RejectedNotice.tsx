// detail: 차단 뒤 Agent가 이어서 한 설명(계약 6장). 스트리밍 중에도 카드 안에서 이어붙는다.
export function RejectedNotice({ reason, detail }: { reason: string; detail?: string }) {
  return (
    <div className="max-w-[85%] rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-[15px] text-red-900">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-red-700">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" />
        차단됨
      </div>
      <p>{reason}</p>
      {detail && (
        <p className="mt-1.5 whitespace-pre-wrap text-neutral-800">{detail}</p>
      )}
    </div>
  )
}
