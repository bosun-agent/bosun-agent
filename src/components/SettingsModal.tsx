import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { ApprovalMode, Settings } from '../lib/agentProtocol'
import { agent } from '../lib/agent'
import { applySetup, getKeyStatus, getSetupStatus, type KeyState, type KeyStatus, type SetupOutcome, type SetupStatus } from '../lib/setup'
import { AuditSection, BackupSection, InfoSection, NotifySection, PolicySection } from './SettingsSections'

// 설정 화면. API 키는 바꿀 수 있고, 정책·정보·승인 기록은 Agent 설정과 WEB 기록을 보여준다.
// 모델은 입력창 옆에서 고른다(2026-11-11 회의).
const SECTIONS = [
  { id: 'api-key', label: 'API 키' },
  { id: 'policy', label: '정책' },
  { id: 'audit', label: '승인 기록' },
  { id: 'backup', label: '백업' },
  { id: 'about', label: '정보' },
  { id: 'notify', label: '알림' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export function SettingsModal({
  activeServerId,
  onClose,
  onDraft,
  onApprovalModeChange,
}: {
  activeServerId?: string
  onClose: () => void
  onApprovalModeChange?: (mode: ApprovalMode) => void
  // 입력창에 글을 채우고 설정을 닫는다(백업 복원 요청).
  onDraft?: (text: string) => void
}) {
  const [sectionId, setSectionId] = useState<SectionId>('api-key')
  const section = SECTIONS.find((s) => s.id === sectionId) ?? SECTIONS[0]

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="설정"
        onClick={(e) => e.stopPropagation()}
        className="flex h-[min(40rem,90vh)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl sm:flex-row"
      >
        <nav className="flex shrink-0 flex-wrap gap-1 bg-neutral-100 p-2 sm:w-44 sm:flex-col sm:flex-nowrap">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSectionId(s.id)}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                s.id === sectionId ? 'bg-sky-100 font-semibold text-navy-900' : 'text-neutral-600 hover:bg-neutral-200'
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <section className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold tracking-[-0.012em]">{section.label}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="설정 닫기"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100"
            >
              ✕
            </button>
          </div>
          {sectionId === 'api-key' && <ApiKeySection />}
          {sectionId === 'policy' && <PolicySection onApprovalModeChange={onApprovalModeChange} />}
          {sectionId === 'audit' && <AuditSection />}
          {sectionId === 'backup' && <BackupSection onDraft={onDraft} />}
          {sectionId === 'about' && <InfoSection activeServerId={activeServerId} />}
          {sectionId === 'notify' && <NotifySection />}
        </section>
      </div>
    </div>
  )
}

function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [failed, setFailed] = useState(!agent.getSettings)

  useEffect(() => {
    agent.getSettings?.().then(setSettings, () => setFailed(true))
  }, [])

  return { settings, setSettings, failed }
}

// Agent는 시작할 때 키를 읽는다. 저장하면 WEB이 띄운 Agent를 다시 시작한다.
const SAVED_TEXT: Record<NonNullable<Settings['agentRestart']> | 'saved', string> = {
  started: '저장했어요. 새 키로 AI Agent를 다시 켜고 있어요.',
  waiting: '저장했어요. 처리 중인 대화가 끝나면 AI Agent를 다시 켜서 새 키를 적용해요.',
  manual: '저장했어요. AI Agent를 띄운 창에서 Agent를 다시 시작해야 새 키가 적용돼요.',
  saved: '저장했어요. AI Agent를 다시 시작해야 새 키가 적용돼요.',
}

type CardState = KeyState | 'loading'

const STATE_BADGE: Record<CardState, { label: string; dot: string; text: string }> = {
  ok: { label: '연결됨', dot: 'bg-emerald-500', text: 'text-emerald-700' },
  error: { label: '연결 안 됨', dot: 'bg-red-500', text: 'text-red-700' },
  unset: { label: '키 없음', dot: 'bg-neutral-400', text: 'text-neutral-500' },
  loading: { label: '확인 중', dot: 'bg-neutral-300', text: 'text-neutral-500' },
}

const money = (n: number) => `$${n.toFixed(2)}`
// 이보다 적으면 곧 402로 답을 못 할 수 있다고 알린다.
const LOW_CREDITS = 0.5

// 남은 크레딧 한 줄. 계정 잔액을 못 받으면 키 한도, 그것도 없으면 이 키로 쓴 금액.
function creditText(c: NonNullable<KeyStatus['openrouter']['credits']>): { text: string; low: boolean } | null {
  if (c.remaining !== undefined) return { text: `${money(c.remaining)}${c.total !== undefined ? ` (충전 ${money(c.total)})` : ''}`, low: c.remaining < LOW_CREDITS }
  if (typeof c.limitRemaining === 'number') return { text: `키 한도 ${money(c.limitRemaining)} 남음`, low: c.limitRemaining < LOW_CREDITS }
  if (c.usage !== undefined) return { text: `이 키로 쓴 금액 ${money(c.usage)}`, low: false }
  return null
}

function KeyCard({
  title,
  state,
  message,
  rows,
  children,
}: {
  title: string
  state: CardState
  message?: string
  rows: [string, ReactNode][]
  children: ReactNode
}) {
  const badge = STATE_BADGE[state]
  return (
    <section aria-label={title} className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-[15px] font-semibold text-neutral-900">{title}</h3>
        <span className={`flex items-center gap-1.5 text-xs font-medium ${badge.text}`}>
          <span className={`inline-block h-2 w-2 rounded-full ${badge.dot}`} />
          {badge.label}
        </span>
      </div>
      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-neutral-500">{k}</dt>
            <dd className="break-all text-neutral-800">{v}</dd>
          </div>
        ))}
      </dl>
      {state === 'error' && message && <p className="mt-2 text-sm text-red-600">{message}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

function KeyForm({
  label,
  placeholder,
  onSave,
  extra,
  canSaveExtra = false,
}: {
  label: string
  placeholder: string
  // 결과 문장(성공) 또는 Error(실패 이유)
  onSave: (value: string) => Promise<string>
  extra?: ReactNode
  canSaveExtra?: boolean
}) {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ text: string; error?: boolean } | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (saving || (!value.trim() && !canSaveExtra)) return
    setSaving(true)
    setResult(null)
    try {
      setResult({ text: await onSave(value.trim()) })
      setValue('')
    } catch (err) {
      setResult({ text: err instanceof Error ? err.message : '저장하지 못했어요.', error: true })
    } finally {
      setSaving(false)
    }
  }

  const ready = !saving && (value.trim() !== '' || canSaveExtra)
  return (
    <form onSubmit={submit} className="space-y-2">
      {extra}
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          aria-label={label}
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-[13px]"
        />
        <button
          type="submit"
          disabled={!ready}
          className={`shrink-0 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            ready ? 'bg-navy-800 text-white hover:bg-navy-900' : 'bg-neutral-200 text-neutral-500'
          }`}
        >
          {saving ? '확인하는 중…' : '저장'}
        </button>
      </div>
      {result && <p className={`text-sm ${result.error ? 'text-red-600' : 'text-neutral-700'}`}>{result.text}</p>}
    </form>
  )
}

function setupSavedText(r: Extract<SetupOutcome, { ok: true }>): string {
  if (r.notice) return `저장했어요. ${r.notice}`
  return r.ready ? '저장했어요. 새 키로 AI Agent를 다시 켰어요.' : SAVED_TEXT.started
}

// 키는 Agent env 파일에 저장된다. 화면은 키 값을 다시 받지 않고 가린 값(앞부분 + 끝 4자리)만 보여준다.
// 두 키 모두 저장하기 전에 실제로 쓸 수 있는지 확인한다(server/setup.ts applySetup). 백엔드가 없으면(목업) 예전 저장만 쓴다.
function ApiKeySection() {
  const { settings, setSettings, failed } = useSettings()
  const [setup, setSetup] = useState<SetupStatus | null | undefined>(undefined)
  const [keys, setKeys] = useState<KeyStatus | null | undefined>(undefined)
  // Portainer에 못 붙었을 때만 주소 칸을 보여 준다.
  const [url, setUrl] = useState('')

  function refresh() {
    setKeys(undefined)
    getKeyStatus().then(setKeys, () => setKeys(null))
  }
  useEffect(() => {
    getSetupStatus().then(
      (s) => {
        setSetup(s)
        setUrl(s?.portainer.url ?? '')
      },
      () => setSetup(null),
    )
    getKeyStatus().then(setKeys, () => setKeys(null))
  }, [])

  if (failed) return <p className="px-1 text-sm text-red-600">설정을 불러오지 못했어요.</p>
  if (!settings || setup === undefined) return <p className="px-1 text-sm text-neutral-500">불러오는 중…</p>
  if (!settings.apiKey.editable) {
    return <p className="px-1 text-sm text-neutral-500">이 서버에서는 API 키를 바꿀 수 없어요. 관리자에게 문의해주세요.</p>
  }

  const backend = setup !== null
  const cardState = (s: KeyStatus['openrouter'] | KeyStatus['portainer'] | undefined, set: boolean): CardState =>
    keys === undefined ? 'loading' : s ? s.state : set ? 'loading' : 'unset'
  const orState = backend ? cardState(keys?.openrouter, settings.apiKey.set) : settings.apiKey.set ? 'ok' : 'unset'
  const credits = keys?.openrouter.credits ? creditText(keys.openrouter.credits) : null
  const pt = setup?.portainer
  const ptState = cardState(keys?.portainer, !!pt?.keySet)
  const showUrl = (ptState === 'error' && keys?.portainer.field === 'portainerUrl') || (pt !== undefined && !pt.urlSet)
  const urlChanged = showUrl && url.trim() !== '' && url.trim().replace(/\/+$/, '') !== (pt?.url ?? '')

  async function saveOpenRouter(value: string): Promise<string> {
    if (!backend) {
      if (!agent.saveApiKey) throw new Error('저장할 수 없어요.')
      const next = await agent.saveApiKey(value)
      setSettings(next)
      return SAVED_TEXT[next.agentRestart ?? 'saved']
    }
    const r = await applySetup({ openrouterKey: value })
    if (!r.ok) throw new Error(r.fields.openrouterKey ?? r.fields.form ?? '저장하지 못했어요.')
    setSetup(r.status)
    agent.getSettings?.().then(setSettings, () => undefined)
    refresh()
    return setupSavedText(r)
  }

  async function savePortainer(value: string): Promise<string> {
    const r = await applySetup({ ...(value ? { portainerApiKey: value } : {}), ...(urlChanged ? { portainerUrl: url.trim() } : {}) })
    if (!r.ok) throw new Error(r.fields.portainerApiKey ?? r.fields.portainerUrl ?? r.fields.form ?? '저장하지 못했어요.')
    setSetup(r.status)
    setUrl(r.status.portainer.url ?? '')
    refresh()
    return setupSavedText(r)
  }

  return (
    <div className="space-y-3">
      <KeyCard
        title="OpenRouter 키"
        state={orState}
        message={keys?.openrouter.message}
        rows={[
          ['저장된 키', <span key="key" className="font-mono text-[13px]">{settings.apiKey.set ? (settings.apiKey.masked ?? '있음') : '없음'}</span>],
          ...(backend && orState !== 'unset'
            ? ([
                [
                  '남은 크레딧',
                  keys === undefined ? (
                    <span key="v" className="text-neutral-500">확인 중…</span>
                  ) : credits ? (
                    <span key="v" className={credits.low ? 'font-medium text-amber-700' : ''}>
                      {credits.text}
                      {credits.low && <span className="block text-xs">잔액이 적어요. 모자라면 AI가 답을 하지 못해요.</span>}
                    </span>
                  ) : (
                    <span key="v" className="text-neutral-500">알 수 없어요</span>
                  ),
                ],
              ] as [string, ReactNode][])
            : []),
        ]}
      >
        <KeyForm label="OpenRouter 키" placeholder={settings.apiKey.set ? '새 키로 바꾸기' : 'OpenRouter 키'} onSave={saveOpenRouter} />
      </KeyCard>
      {pt && (
        <KeyCard
          title="Portainer 키"
          state={ptState}
          message={keys?.portainer.message}
          rows={[
            ['저장된 키', <span key="key" className="font-mono text-[13px]">{pt.keySet ? (pt.keyMasked ?? '있음') : '없음'}</span>],
            ['주소', <span key="url" className="font-mono text-[13px]">{pt.url ?? '없음'}</span>],
          ]}
        >
          <KeyForm
            label="Portainer 키"
            placeholder={pt.keySet ? '새 키로 바꾸기' : 'Portainer 키'}
            onSave={savePortainer}
            canSaveExtra={urlChanged}
            extra={
              showUrl && (
                <label className="block text-sm">
                  <span className="text-neutral-600">Portainer 주소</span>
                  <input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder={setup?.portainerUrlHint}
                    aria-label="Portainer 주소"
                    className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-[13px]"
                  />
                </label>
              )
            }
          />
        </KeyCard>
      )}
    </div>
  )
}
