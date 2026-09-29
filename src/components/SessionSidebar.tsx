import type { ChatSession } from '../types'

interface SessionSidebarProps {
  sessions: ChatSession[]
  activeId: string
  busyId: string | null
  onClose: () => void
  onSelect: (id: string) => void
  onNew: () => void
}

// 열렸을 때만 그린다. 넓은 화면에서는 채팅을 오른쪽으로 밀고, 좁은 화면에서는 위에 겹친다.
export function SessionSidebar({
  sessions,
  activeId,
  busyId,
  onClose,
  onSelect,
  onNew,
}: SessionSidebarProps) {
  return (
    <>
      <div
        className="fixed inset-0 z-10 bg-black/30 md:hidden"
        onClick={onClose}
      />
      <aside className="fixed inset-y-0 left-0 z-20 flex w-64 shrink-0 flex-col bg-neutral-50 md:static">
        <div className="flex items-center gap-2 px-3 pt-3 pb-2">
          <SidebarToggle label="대화 목록 닫기" onClick={onClose} />
          <span className="font-semibold">BOSUN</span>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
          <button
            type="button"
            onClick={onNew}
            className="mb-2 w-full rounded-lg px-3 py-2 text-left text-sm font-medium hover:bg-neutral-100"
          >
            + 새 대화
          </button>
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelect(session.id)}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${
                session.id === activeId
                  ? 'bg-neutral-200 font-medium'
                  : 'text-neutral-600 hover:bg-neutral-100'
              }`}
            >
              <span className="flex-1 truncate">{session.title}</span>
              {session.id === busyId && (
                <span
                  className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500"
                  title="처리 중"
                />
              )}
            </button>
          ))}
        </nav>
      </aside>
    </>
  )
}

// 사이드바를 열고 닫는 버튼. 열기·닫기 모두 왼쪽 위 같은 자리에 둔다.
export function SidebarToggle({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100"
    >
      ☰
    </button>
  )
}
