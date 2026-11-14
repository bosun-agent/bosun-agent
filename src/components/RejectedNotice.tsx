// 정책 차단 안내. 차단 뒤 Agent가 이어서 한 말은 그 아래 일반 말풍선에 나온다.
// resolved: 차단 뒤에 승인한 작업이 있다(processSteps.blockResolved). 빨간 경고 대신 회색 안내로 보여준다.
// portainer: 정책 차단이면 Portainer에서 직접 하라고 안내한다. 빈 문자열이면 주소를 몰라 링크 없이 문구만 둔다.
// 뒤에 승인한 작업이 있으면(resolved) 이미 다른 길로 진행했으므로 안내하지 않는다.
export function RejectedNotice({
  reason,
  details = [],
  resolved = false,
  portainer,
}: {
  reason: string
  details?: string[]
  resolved?: boolean
  portainer?: string
}) {
  const box = resolved ? 'border-neutral-200 bg-neutral-50 text-neutral-700' : 'border-red-200 bg-white text-neutral-900'
  return (
    <div className={`w-full max-w-[560px] rounded-2xl border px-4 py-3.5 text-[15px] ${box}`}>
      <div className={`mb-1 flex items-center gap-1.5 text-xs font-medium ${resolved ? 'text-neutral-500' : 'text-red-700'}`}>
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${resolved ? 'bg-neutral-400' : 'bg-red-500'}`} />
        {resolved ? '도중에 막힌 요청' : '차단됨'}
      </div>
      <p className="font-semibold">{resolved ? '중간에 보안 정책에 막힌 요청이 있었어요. 막힌 요청은 실행하지 않았고, 그 뒤 승인한 작업은 진행했어요.' : reason}</p>
      {details.length > 0 && (
        <ul className={`mt-1.5 list-disc space-y-0.5 pl-5 text-sm ${resolved ? 'text-neutral-500' : 'text-red-800'}`}>
          {details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      {portainer !== undefined && !resolved && (
        <p className="mt-2 text-sm text-neutral-600">
          꼭 필요한 작업이면 Portainer 화면에서 직접 할 수 있어요.
          {portainer && (
            <>
              {' '}
              <a href={portainer} target="_blank" rel="noopener noreferrer" className="font-medium text-navy-700 underline underline-offset-2">
                Portainer 열기 ↗
              </a>
            </>
          )}
        </p>
      )}
    </div>
  )
}
