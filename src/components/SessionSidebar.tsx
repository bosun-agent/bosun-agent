import { useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ChatSession } from '../types'

interface SessionSidebarProps {
  sessions: ChatSession[]
  activeId: string
  busy: ReadonlySet<string>
  // 서버 대화를 마크다운으로 내려받는 주소. 목업에는 없다.
  exportUrl?: (serverId: string) => string
  onClose: () => void
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  // 고른 대화를 한꺼번에 지운다(확인 창은 App이 띄운다)
  onDeleteMany?: (ids: string[]) => void
  onRename: (id: string, title: string) => void
  onPin?: (id: string, pinned: boolean) => void
  // 로그인했을 때만 있다(목업에는 없음)
  onLogout?: () => void
}

// 열렸을 때만 그린다. 넓은 화면에서는 채팅을 오른쪽으로 밀고, 좁은 화면에서는 위에 겹친다.
export function SessionSidebar({
  sessions,
  activeId,
  busy,
  exportUrl,
  onClose,
  onSelect,
  onNew,
  onDelete,
  onDeleteMany,
  onRename,
  onPin,
  onLogout,
}: SessionSidebarProps) {
  const [query, setQuery] = useState('')
  // 여러 개 골라 지우기. null이면 고르는 중이 아니다.
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null)
  const q = query.trim().toLowerCase()
  // 제목과 이미 불러온 메시지 내용에서 찾는다.
  const matched = q
    ? sessions.filter((s) => s.title.toLowerCase().includes(q) || s.messages.some((m) => m.content.toLowerCase().includes(q)))
    : sessions
  const pinned = matched.filter((s) => s.pinned)
  const rest = matched.filter((s) => !s.pinned)
  // "모두 선택"은 보이는 대화 중 고정하지 않았고 처리 중이 아닌 것만 고른다. 고정한 대화는 하나씩 골라야 지울 수 있다.
  const selectable = rest.filter((s) => !busy.has(s.id))
  const allSelected = selected !== null && selectable.length > 0 && selectable.every((s) => selected.has(s.id))

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectable.map((s) => s.id)))
  }

  function deleteSelected() {
    if (!selected || !onDeleteMany) return
    // 고르는 사이 처리가 시작된 대화는 뺀다.
    const ids = [...selected].filter((id) => !busy.has(id))
    setSelected(null)
    onDeleteMany(ids)
  }

  const rowProps = {
    activeId,
    busy,
    exportUrl,
    onSelect: selected ? toggle : onSelect,
    onDelete,
    onRename,
    onPin,
    selected,
  }

  return (
    <>
      <div className="fixed inset-0 z-10 bg-black/30 md:hidden" onClick={onClose} />
      <aside className="fixed inset-y-1.5 left-1.5 z-20 flex w-64 shrink-0 flex-col rounded-lg bg-neutral-100 md:static md:my-1.5 md:ml-1.5">
        <div className="flex items-center gap-2 px-2 pt-2 pb-1.5">
          <SidebarToggle label="대화 목록 닫기" onClick={onClose} />
          <span className="font-semibold">BOSUN</span>
        </div>
        <div className="space-y-1.5 px-2 pb-1.5">
          <button
            type="button"
            onClick={onNew}
            className="w-full rounded-md bg-neutral-200 px-3 py-1.5 text-left text-sm font-medium hover:bg-neutral-300"
          >
            + 새 대화
          </button>
          <div className="flex gap-1.5">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="대화 찾기"
              aria-label="대화 찾기"
              className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-sm outline-none focus:border-neutral-400"
            />
            {onDeleteMany && (
              <button
                type="button"
                onClick={() => setSelected(selected ? null : new Set())}
                className="shrink-0 rounded-md px-2 text-xs text-neutral-600 hover:bg-neutral-200"
              >
                {selected ? '취소' : '선택'}
              </button>
            )}
          </div>
          {selected && (
            <div className="flex items-center gap-2 px-1 text-xs">
              <label className="flex flex-1 items-center gap-1.5 text-neutral-600">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={selectable.length === 0} />
                모두 선택
              </label>
              <button
                type="button"
                onClick={deleteSelected}
                disabled={selected.size === 0}
                className="rounded-md bg-red-600 px-2 py-1 font-medium text-white disabled:opacity-40"
              >
                삭제 ({selected.size}개)
              </button>
            </div>
          )}
        </div>
        <nav className="flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
          {pinned.length > 0 && (
            <>
              <p className="px-1 pt-1 text-[11px] font-medium text-neutral-500">고정됨</p>
              {pinned.map((s) => (
                <SessionRow key={s.id} session={s} {...rowProps} />
              ))}
              {rest.length > 0 && <p className="px-1 pt-2 text-[11px] font-medium text-neutral-500">대화</p>}
            </>
          )}
          {rest.map((s) => (
            <SessionRow key={s.id} session={s} {...rowProps} />
          ))}
          {q && matched.length === 0 && <p className="px-1 py-2 text-xs text-neutral-500">찾는 대화가 없어요.</p>}
        </nav>
        {onLogout && (
          <div className="border-t border-neutral-200 px-2 py-2">
            <button
              type="button"
              onClick={onLogout}
              className="w-full rounded-md px-3 py-1.5 text-left text-sm text-neutral-600 hover:bg-neutral-200"
            >
              로그아웃
            </button>
          </div>
        )}
      </aside>
    </>
  )
}

function SessionRow({
  session,
  activeId,
  busy,
  exportUrl,
  onSelect,
  onDelete,
  onRename,
  onPin,
  selected,
}: Pick<SessionSidebarProps, 'activeId' | 'busy' | 'exportUrl' | 'onSelect' | 'onDelete' | 'onRename' | 'onPin'> & {
  session: ChatSession
  // 여러 개 골라 지우는 중이면 고른 대화 id들
  selected: ReadonlySet<string> | null
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(session.title)
  const isBusy = busy.has(session.id)

  if (selected) {
    return (
      <label
        className={`flex w-full items-center gap-2 rounded-md bg-neutral-200 py-1.5 pr-2 pl-3 text-sm ${
          isBusy ? 'text-neutral-400' : 'text-neutral-700 hover:bg-neutral-300'
        }`}
      >
        <input
          type="checkbox"
          checked={selected.has(session.id)}
          onChange={() => onSelect(session.id)}
          disabled={isBusy}
          aria-label={`${session.title} 선택`}
        />
        <span className="flex-1 truncate">{session.title}</span>
        {isBusy && <span className="shrink-0 text-[11px]">처리 중</span>}
      </label>
    )
  }
  const usage =
    session.inputTokens !== undefined ? `토큰 입력 ${session.inputTokens.toLocaleString()} · 출력 ${(session.outputTokens ?? 0).toLocaleString()}` : undefined

  function save() {
    setEditing(false)
    onRename(session.id, title)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) save()
    if (e.key === 'Escape') setEditing(false)
  }

  if (editing) {
    return (
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={save}
        autoFocus
        maxLength={100}
        aria-label="대화 제목"
        className="w-full rounded-md border border-neutral-400 bg-white px-3 py-1.5 text-sm outline-none"
      />
    )
  }

  return (
    <div
      className={`group flex w-full items-center rounded-md text-sm ${
        session.id === activeId ? 'bg-neutral-300 font-medium' : 'bg-neutral-200 text-neutral-600 hover:bg-neutral-300'
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        onDoubleClick={() => {
          setTitle(session.title)
          setEditing(true)
        }}
        title={usage}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left"
      >
        <span className="flex-1 truncate">{session.title}</span>
        {isBusy && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" title="처리 중" />}
      </button>
      {/* 터치 화면에서는 항상 보인다. 처리 중인 대화는 서버가 지우지 않으므로 삭제를 숨긴다. */}
      <div className="mr-1 flex shrink-0 items-center md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
        {onPin && (
          <IconButton label={session.pinned ? `${session.title} 고정 풀기` : `${session.title} 고정`} onClick={() => onPin(session.id, !session.pinned)}>
            <PinIcon filled={session.pinned === true} />
          </IconButton>
        )}
        <IconButton
          label={`${session.title} 이름 바꾸기`}
          onClick={() => {
            setTitle(session.title)
            setEditing(true)
          }}
        >
          <EditIcon />
        </IconButton>
        {exportUrl && session.serverId && (
          <a
            href={exportUrl(session.serverId)}
            download
            aria-label={`${session.title} 내보내기`}
            title="마크다운으로 내보내기"
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-400/40 hover:text-neutral-800"
          >
            <DownloadIcon />
          </a>
        )}
        {!isBusy && (
          <IconButton label={`${session.title} 삭제`} onClick={() => onDelete(session.id)} danger>
            <TrashIcon />
          </IconButton>
        )}
      </div>
    </div>
  )
}

function IconButton({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-400/40 ${danger ? 'hover:text-red-700' : 'hover:text-neutral-800'}`}
    >
      {children}
    </button>
  )
}

const ICON = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

function TrashIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
    </svg>
  )
}

function EditIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14" />
    </svg>
  )
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg {...ICON} fill={filled ? 'currentColor' : 'none'} aria-hidden>
      <path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4Z" />
    </svg>
  )
}

// 사이드바를 열고 닫는 버튼. 열기·닫기 모두 왼쪽 위 같은 자리에 둔다.
export function SidebarToggle({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-600 hover:bg-neutral-200"
    >
      ☰
    </button>
  )
}
