import { useMemo, useState, type DragEvent } from 'react'
import type { AgentRestart, PolicyBucket, PolicyItem, PolicyState, Settings } from '../lib/agentProtocol'
import { agent } from '../lib/agent'

// 설정 > 정책: 작업을 허용·묻기·막기 칸으로 옮긴다(2026-11-11 회의). 끌어다 놓거나, 눌러서 옮길 칸을 고른다(폰·키보드).
// 저장하면 WEB 백엔드가 Agent 설정 파일의 permissions에 적고 Agent를 다시 시작한다(server/policy.ts).

const COLUMNS: { bucket: PolicyBucket; title: string; help: string; tone: string; head: string }[] = [
  { bucket: 'allow', title: '허용', help: '승인 카드 없이 바로 실행', tone: 'border-sky-200 bg-sky-50/40', head: 'text-navy-800' },
  { bucket: 'ask', title: '묻기', help: '승인 카드를 띄움', tone: 'border-amber-200 bg-amber-50/40', head: 'text-amber-800' },
  { bucket: 'deny', title: '막기', help: '승인해도 실행 안 함', tone: 'border-red-200 bg-red-50/40', head: 'text-red-800' },
]

const TITLE: Record<PolicyBucket, string> = { allow: '허용', ask: '묻기', deny: '막기' }

const RESTART_TEXT: Record<AgentRestart, string> = {
  started: '저장했어요. AI Agent를 다시 시작하고 있어요. 새로 시작한 뒤부터 적용돼요.',
  waiting: '저장했어요. 처리 중인 대화가 끝나면 AI Agent를 다시 시작해요.',
  manual: '설정 파일에 저장했어요. WEB이 띄운 Agent가 아니라서, Agent를 직접 다시 시작해야 적용돼요.',
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="inline h-3 w-3 -translate-y-px">
      <path fill="currentColor" d="M5 7V5a3 3 0 1 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 1 0-3 0v2Z" />
    </svg>
  )
}

export function PolicyBoard({ initial, settings }: { initial: PolicyState; settings: Settings | null }) {
  const [state, setState] = useState(initial)
  // 화면에서 옮긴 칸(저장 전). 저장한 상태와 같으면 비어 있다.
  const [draft, setDraft] = useState<Record<string, PolicyBucket>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [over, setOver] = useState<PolicyBucket | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)

  const bucketOf = (it: PolicyItem) => draft[it.id] ?? it.bucket
  const dirty = Object.keys(draft).length
  const customized = state.items.some((it) => !it.lock && bucketOf(it) !== it.defaultBucket)
  const never = settings?.approvalMode === 'never'

  const columns = useMemo(
    () =>
      COLUMNS.map((col) => {
        const items = state.items.filter((it) => (draft[it.id] ?? it.bucket) === col.bucket)
        const groups = [...new Set(items.map((it) => it.group))].map((g) => ({ group: g, items: items.filter((it) => it.group === g) }))
        return { ...col, count: items.length, groups }
      }),
    [state.items, draft],
  )

  function move(id: string, to: PolicyBucket) {
    const item = state.items.find((it) => it.id === id)
    setOpen(null)
    if (!item || item.lock || bucketOf(item) === to) return
    // 바꾸는 작업을 허용으로 옮길 때만 한 번 묻는다(묻지 않기를 켤 때처럼). 막지는 않는다.
    if (
      to === 'allow' &&
      item.change &&
      !window.confirm(`'${item.label}'을(를) 허용으로 옮기면 승인 카드 없이 바로 실행돼요. AI가 대상을 잘못 골라도 멈출 기회가 없어요. 옮길까요?`)
    ) {
      return
    }
    setMessage(null)
    setDraft((d) => {
      const next = { ...d }
      if (to === item.bucket) delete next[id]
      else next[id] = to
      return next
    })
  }

  function resetToDefault() {
    setMessage(null)
    setDraft(Object.fromEntries(state.items.filter((it) => !it.lock && it.bucket !== it.defaultBucket).map((it) => [it.id, it.defaultBucket])))
  }

  async function save() {
    if (!agent.savePolicy || saving) return
    setSaving(true)
    setMessage(null)
    try {
      const buckets = Object.fromEntries(state.items.map((it) => [it.id, bucketOf(it)]))
      const res = await agent.savePolicy(buckets)
      setState(res)
      setDraft({})
      setMessage({ text: RESTART_TEXT[res.restart] })
    } catch (err) {
      setMessage({ text: err instanceof Error && err.message ? err.message : '저장하지 못했어요. 다시 시도해주세요.', error: true })
    } finally {
      setSaving(false)
    }
  }

  function onDrop(e: DragEvent, to: PolicyBucket) {
    e.preventDefault()
    setOver(null)
    const id = e.dataTransfer.getData('text/plain')
    if (id) move(id, to)
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-neutral-900">작업별 허용·묻기·막기</h3>
        <p className="text-xs text-neutral-500">끌어다 놓거나, 눌러서 옮길 칸을 고르세요.</p>
      </div>
      {never && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-700">
          지금은 승인 방식이 "묻지 않기"라서 묻기 칸의 작업도 WEB이 대신 승인해 바로 실행돼요.
        </p>
      )}
      <div className="mt-2 grid gap-2 md:grid-cols-3">
        {columns.map((col) => (
          <section
            key={col.bucket}
            aria-label={`${col.title} 칸`}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(col.bucket)
            }}
            onDragLeave={() => setOver((o) => (o === col.bucket ? null : o))}
            onDrop={(e) => onDrop(e, col.bucket)}
            className={`min-h-24 rounded-lg border p-2 transition-shadow ${col.tone} ${over === col.bucket ? 'ring-2 ring-navy-300' : ''}`}
          >
            <header className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className={`text-sm font-semibold ${col.head}`}>
                {col.title} <span className="font-normal text-neutral-500">{col.count}</span>
              </span>
              <span className="text-[11px] text-neutral-500">{col.help}</span>
            </header>
            {col.count === 0 && <p className="py-3 text-center text-xs text-neutral-400">여기로 옮겨 놓을 수 있어요</p>}
            {col.groups.map(({ group, items }) => (
              <div key={group} className="mb-1.5 last:mb-0">
                <p className="mb-0.5 text-[11px] text-neutral-500">{group}</p>
                <ul className="flex flex-wrap gap-1">
                  {items.map((it) => {
                    const moved = draft[it.id] !== undefined
                    const differs = !it.lock && bucketOf(it) !== it.defaultBucket
                    return (
                      <li key={it.id} className="max-w-full">
                        <button
                          type="button"
                          draggable={!it.lock}
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/plain', it.id)
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          onDragEnd={() => setOver(null)}
                          onClick={() => !it.lock && setOpen((o) => (o === it.id ? null : it.id))}
                          aria-expanded={it.lock ? undefined : open === it.id}
                          aria-disabled={it.lock ? true : undefined}
                          title={
                            it.lock
                              ? '정책 훅이 막는 작업이라 다른 칸으로 옮겨도 실행되지 않아요.'
                              : differs
                                ? `기본값은 ${TITLE[it.defaultBucket]}이에요.`
                                : undefined
                          }
                          className={`max-w-full rounded-full border px-2 py-0.5 text-left text-xs break-all transition-colors ${
                            it.lock
                              ? 'cursor-not-allowed border-neutral-200 bg-neutral-100 text-neutral-500'
                              : `cursor-grab bg-white text-neutral-800 hover:border-navy-300 active:cursor-grabbing ${
                                  moved ? 'border-navy-600 ring-1 ring-navy-300' : differs ? 'border-navy-300' : 'border-neutral-200'
                                }`
                          } ${it.raw ? 'font-mono text-[11px]' : ''}`}
                        >
                          {it.lock && (
                            <span className="mr-1 text-neutral-400">
                              <LockIcon />
                            </span>
                          )}
                          {it.label}
                          {differs && <span className="ml-1 text-[10px] text-navy-600">바뀜</span>}
                        </button>
                        {open === it.id && (
                          <span className="mt-0.5 flex flex-wrap gap-1" role="group" aria-label={`${it.label} 옮기기`}>
                            {COLUMNS.filter((c) => c.bucket !== bucketOf(it)).map((c) => (
                              <button
                                key={c.bucket}
                                type="button"
                                onClick={() => move(it.id, c.bucket)}
                                className="rounded-md border border-neutral-300 bg-white px-1.5 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-50"
                              >
                                {c.title}(으)로
                              </button>
                            ))}
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </section>
        ))}
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        허용 칸은 승인 카드 없이 실행되고, 바꾸는 작업이면 승인 기록에 "허용 칸이라 바로 실행"으로 남아요. <LockIcon /> 표시는 정책 훅이 막는 작업이라 옮길 수 없어요.
        저장하면 Agent 설정 파일({state.files.join(', ')})에 적고 AI Agent를 다시 시작해요.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        {message && <p className={`mr-auto text-sm ${message.error ? 'text-red-600' : 'text-neutral-700'}`}>{message.text}</p>}
        {customized && (
          <button type="button" onClick={resetToDefault} disabled={saving} className="rounded-lg px-2.5 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100">
            기본값으로
          </button>
        )}
        {dirty > 0 && (
          <>
            <button
              type="button"
              onClick={() => {
                setDraft({})
                setMessage(null)
              }}
              disabled={saving}
              className="rounded-lg px-2.5 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-lg bg-navy-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-900 disabled:opacity-60"
            >
              {saving ? '저장하는 중…' : `${dirty}개 바꾼 것 저장하고 Agent 다시 시작`}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
