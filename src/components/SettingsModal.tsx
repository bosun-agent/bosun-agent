import { useEffect, useState, type FormEvent } from 'react'
import type { Settings } from '../lib/agentProtocol'
import { agent } from '../lib/agent'
import { AuditSection, BackupSection, InfoSection, NotifySection, PolicySection } from './SettingsSections'

// 설정 화면. 모델·API 키는 바꿀 수 있고, 정책·정보·승인 기록은 Agent 설정과 WEB 기록을 보여준다.
const SECTIONS = [
  { id: 'model', label: '모델' },
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
}: {
  activeServerId?: string
  onClose: () => void
  // 입력창에 글을 채우고 설정을 닫는다(백업 복원 요청).
  onDraft?: (text: string) => void
}) {
  const [sectionId, setSectionId] = useState<SectionId>('model')
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
        className="flex h-[min(40rem,90vh)] w-full max-w-3xl flex-col gap-1 overflow-hidden rounded-lg border border-neutral-300 bg-neutral-100 p-1 shadow-lg sm:flex-row"
      >
        <nav className="flex shrink-0 gap-1 overflow-x-auto rounded-md bg-neutral-100 p-1 sm:w-44 sm:flex-col">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSectionId(s.id)}
              className={`shrink-0 rounded-md px-3 py-1.5 text-left text-sm ${
                s.id === sectionId ? 'bg-neutral-300 font-medium' : 'bg-neutral-200 text-neutral-600 hover:bg-neutral-300'
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <section className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto rounded-md bg-neutral-100 p-2">
          <div className="flex items-center justify-between">
            <h2 className="rounded-md bg-neutral-200 px-3 py-1 text-sm font-medium">{section.label}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="설정 닫기"
              className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-200"
            >
              ✕
            </button>
          </div>
          {sectionId === 'model' && <ModelSection />}
          {sectionId === 'api-key' && <ApiKeySection />}
          {sectionId === 'policy' && <PolicySection />}
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

// 고르면 바로 저장한다. 다음 메시지부터 그 모델로 보낸다.
function ModelSection() {
  const { settings, setSettings, failed: loadFailed } = useSettings()
  const [failed, setFailed] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [newModel, setNewModel] = useState('')

  async function run(fn: () => Promise<Settings>, message: string) {
    if (saving) return false
    setSaving(true)
    setFailed(null)
    try {
      setSettings(await fn())
      return true
    } catch {
      setFailed(message)
      return false
    } finally {
      setSaving(false)
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    const model = newModel.trim()
    if (!model || !agent.addModel) return
    const ok = await run(() => agent.addModel!(model), '더하지 못했어요. agent.yaml 모델 이름이나 provider/model 형식으로 적어주세요.')
    if (ok) setNewModel('')
  }

  if (loadFailed && !settings) return <p className="px-1 text-sm text-red-600">설정을 불러오지 못했어요.</p>
  if (!settings) return <p className="px-1 text-sm text-neutral-500">불러오는 중…</p>

  return (
    <div className="space-y-1.5">
      {settings.models.length === 0 ? (
        <p className="px-1 text-sm text-neutral-500">고를 수 있는 모델이 없어요. AI Agent 설정에 적힌 모델을 써요.</p>
      ) : (
        <p className="px-1 text-xs text-neutral-500">다음 메시지부터 고른 모델로 답해요. 이미 있는 대화도 다음 메시지부터 바뀌어요.</p>
      )}
      {settings.models.map((model) => {
        const custom = settings.customModels?.includes(model)
        return (
          <div key={model} className="flex items-center gap-2 rounded-md bg-white px-3 py-2 text-sm hover:bg-neutral-50">
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="model"
                checked={settings.model === model}
                disabled={saving}
                onChange={() => agent.saveModel && run(() => agent.saveModel!(model), '저장하지 못했어요. 다시 골라주세요.')}
              />
              <span className="truncate font-mono text-[13px]">{model}</span>
            </label>
            {custom && agent.removeModel && (
              <button
                type="button"
                disabled={saving}
                onClick={() => run(() => agent.removeModel!(model), '지우지 못했어요.')}
                className="shrink-0 rounded px-1.5 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-red-700"
              >
                빼기
              </button>
            )}
          </div>
        )
      })}
      {agent.addModel && (
        <form onSubmit={add} className="space-y-1 pt-2">
          <p className="px-1 text-xs text-neutral-500">
            모델 더하기: agent.yaml의 모델 이름(예: <code>flash</code>)이나 <code>provider/model</code>(예:{' '}
            <code>openrouter/deepseek/deepseek-v4.1</code>). 그 provider의 API 키가 Agent에 있어야 해요.
          </p>
          <div className="flex gap-2">
            <input
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              placeholder="openrouter/..."
              aria-label="더할 모델"
              className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-[13px]"
            />
            <button type="submit" disabled={saving || !newModel.trim()} className="shrink-0 rounded-md bg-neutral-800 px-3 py-2 text-sm text-white disabled:opacity-40">
              더하기
            </button>
          </div>
        </form>
      )}
      {failed && <p className="px-1 text-sm text-red-600">{failed}</p>}
    </div>
  )
}

// 키는 Agent env 파일에 저장된다. 화면은 키 값을 다시 받지 않고 저장 여부만 보여준다.
function ApiKeySection() {
  const { settings, setSettings, failed } = useSettings()
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    const apiKey = value.trim()
    if (!agent.saveApiKey || saving || !apiKey) return
    setSaving(true)
    setSaved(false)
    setSaveFailed(false)
    try {
      setSettings(await agent.saveApiKey(apiKey))
      setValue('')
      setSaved(true)
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }

  if (failed) return <p className="px-1 text-sm text-red-600">설정을 불러오지 못했어요.</p>
  if (!settings) return <p className="px-1 text-sm text-neutral-500">불러오는 중…</p>
  if (!settings.apiKey.editable) {
    return <p className="px-1 text-sm text-neutral-500">이 서버에서는 API 키를 바꿀 수 없어요. 관리자에게 문의해주세요.</p>
  }

  return (
    <form onSubmit={save} className="space-y-2">
      <p className="px-1 text-sm">{settings.apiKey.set ? '저장된 키가 있어요.' : '저장된 키가 없어요.'}</p>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={settings.apiKey.set ? '새 키로 바꾸기' : 'API 키'}
          autoComplete="off"
          aria-label="API 키"
          className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-[13px]"
        />
        <button type="submit" disabled={saving || !value.trim()} className="shrink-0 rounded-md bg-neutral-800 px-3 py-2 text-sm text-white disabled:opacity-40">
          저장
        </button>
      </div>
      {saved && <p className="px-1 text-sm text-neutral-700">저장했어요. AI Agent를 다시 시작해야 새 키가 적용돼요.</p>}
      {saveFailed && <p className="px-1 text-sm text-red-600">저장하지 못했어요. 키를 확인하고 다시 시도해주세요.</p>}
    </form>
  )
}
