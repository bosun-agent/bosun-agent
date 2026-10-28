// 정책 차단 안내. 차단 뒤 Agent가 이어서 한 말은 그 아래 일반 말풍선에 나온다.
// resolved: 차단 뒤에 승인한 작업이 있다(processSteps.blockResolved). 빨간 경고 대신 회색 안내로 보여준다.
export function RejectedNotice({ reason, details = [], resolved = false }: { reason: string; details?: string[]; resolved?: boolean }) {
  const box = resolved ? 'border-neutral-200 bg-neutral-50 text-neutral-700' : 'border-red-300 bg-red-50 text-red-900'
  return (
    <div className={`max-w-[85%] rounded-2xl border px-4 py-3 text-[15px] ${box}`}>
      <div className={`mb-1 flex items-center gap-1.5 text-xs font-medium ${resolved ? 'text-neutral-500' : 'text-red-700'}`}>
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${resolved ? 'bg-neutral-400' : 'bg-red-500'}`} />
        {resolved ? '도중에 막힌 요청' : '차단됨'}
      </div>
      <p>{resolved ? '중간에 보안 정책에 막힌 요청이 있었어요. 막힌 요청은 실행하지 않았고, 그 뒤 승인한 작업은 진행했어요.' : reason}</p>
      {details.length > 0 && (
        <ul className={`mt-1.5 list-disc space-y-0.5 pl-5 text-sm ${resolved ? 'text-neutral-500' : 'text-red-800'}`}>
          {details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
