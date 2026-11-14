import { useEffect, useRef, useState } from 'react'
import type { ModelCatalog } from '../lib/agentProtocol'
import { agent } from '../lib/agent'

// 입력창 안 모델 선택. 고르면 바로 저장하고 다음 메시지부터 그 모델로 보낸다(Agent 다시 시작 없음).
// 목록은 처음 열 때 받는다. 전체 목록은 수백 개라 검색칸으로 거르고, 한 번에 일부만 그린다.

const SHOWN_MAX = 150

// `openrouter/deepseek/deepseek-v4.1-flash` → `deepseek-v4.1-flash`. agent.yaml 이름(`flash`)은 그대로.
function shortModel(id: string): string {
  return id.split('/').at(-1) ?? id
}

export function ModelPicker({ model, onChange }: { model: string | null; onChange: (model: string) => void }) {
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: PointerEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  function toggle() {
    const next = !open
    setOpen(next)
    setQuery('')
    setSaveFailed(false)
    // 열 때마다 다시 받는다. 서버가 잠시 기억해 두므로 빠르다(API 키를 바꾼 뒤에는 새 목록).
    if (next && agent.getModels) {
      setLoadFailed(false)
      agent.getModels().then(setCatalog, () => setLoadFailed(true))
    }
  }

  async function pick(id: string) {
    if (!agent.saveModel || saving) return
    if (id === model) {
      setOpen(false)
      return
    }
    setSaving(true)
    setSaveFailed(false)
    try {
      const settings = await agent.saveModel(id)
      onChange(settings.model ?? id)
      setOpen(false)
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const q = query.trim().toLowerCase()
  const match = (id: string, detail?: string) => !q || id.toLowerCase().includes(q) || (detail?.toLowerCase().includes(q) ?? false)
  const recommended = (catalog?.recommended ?? []).filter((m) => match(m.id, m.detail))
  const all = (catalog?.models ?? []).filter((id) => match(id))
  const label = model ? shortModel(model) : '기본 모델'

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={toggle}
        aria-label="모델 선택"
        aria-expanded={open}
        title={model ?? 'AI Agent 설정에 적힌 모델'}
        className="flex h-8 max-w-[7.5rem] items-center gap-0.5 rounded-full px-2 text-xs text-neutral-600 hover:bg-neutral-100 sm:max-w-[11rem]"
      >
        <span className="truncate">{label}</span>
        <span aria-hidden className="text-[10px] text-neutral-400">
          ▾
        </span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="모델 고르기"
          className="absolute right-0 bottom-full z-20 mb-2 flex max-h-[min(24rem,55vh)] w-[min(20rem,calc(100vw-2rem))] flex-col rounded-xl border border-neutral-300 bg-white shadow-lg"
        >
          <div className="border-b border-neutral-200 p-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
              placeholder="모델 찾기"
              aria-label="모델 찾기"
              className="w-full rounded-lg bg-neutral-100 px-2.5 py-1.5 text-sm outline-none placeholder:text-neutral-500 focus:bg-white focus:ring-1 focus:ring-navy-300"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {!catalog && !loadFailed && <p className="px-2 py-2 text-xs text-neutral-500">불러오는 중…</p>}
            {loadFailed && <p className="px-2 py-2 text-xs text-red-600">모델 목록을 불러오지 못했어요.</p>}
            {catalog && (
              <>
                {recommended.length > 0 && <GroupTitle>권장</GroupTitle>}
                {recommended.map((m) => (
                  <ModelRow key={m.id} id={m.id} detail={m.detail} selected={m.id === model} disabled={saving} onPick={pick} />
                ))}
                {all.length > 0 && <GroupTitle>{`전체 (${all.length.toLocaleString()}개)`}</GroupTitle>}
                {all.slice(0, SHOWN_MAX).map((id) => (
                  <ModelRow key={id} id={id} selected={id === model} disabled={saving} onPick={pick} />
                ))}
                {all.length > SHOWN_MAX && (
                  <p className="px-2 py-1.5 text-[11px] text-neutral-500">{`${(all.length - SHOWN_MAX).toLocaleString()}개 더 있어요. 이름으로 찾아보세요.`}</p>
                )}
                {q && recommended.length === 0 && all.length === 0 && <p className="px-2 py-2 text-xs text-neutral-500">찾는 모델이 없어요.</p>}
                {catalog.error && (
                  <p className="px-2 py-1.5 text-[11px] text-neutral-500">
                    {catalog.error === 'unavailable'
                      ? '전체 모델 목록은 WEB이 AI Agent를 띄울 때만 보여요(AGENT_BIN).'
                      : '전체 모델 목록을 받지 못했어요. API 키를 확인해주세요.'}
                  </p>
                )}
              </>
            )}
          </div>
          <p className="border-t border-neutral-200 px-3 py-1.5 text-[11px] text-neutral-500">
            {saveFailed ? <span className="text-red-600">바꾸지 못했어요. 다시 골라주세요.</span> : '다음 메시지부터 고른 모델로 답해요.'}
          </p>
        </div>
      )}
    </div>
  )
}

function GroupTitle({ children }: { children: string }) {
  return <p className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-neutral-500">{children}</p>
}

function ModelRow({
  id,
  detail,
  selected,
  disabled,
  onPick,
}: {
  id: string
  detail?: string
  selected: boolean
  disabled: boolean
  onPick: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      disabled={disabled}
      aria-pressed={selected}
      title={id}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${selected ? 'bg-navy-50 text-navy-900' : 'text-neutral-800 hover:bg-neutral-100'}`}
    >
      <span className="w-3 shrink-0 text-xs text-navy-700">{selected ? '✓' : ''}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{shortModel(id)}</span>
        <span className="block truncate text-[11px] text-neutral-500">{detail ?? id}</span>
      </span>
    </button>
  )
}
