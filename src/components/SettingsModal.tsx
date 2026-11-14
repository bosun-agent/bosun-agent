import { useEffect, useState, type FormEvent } from 'react'
import type { ApprovalMode, Settings } from '../lib/agentProtocol'
import { agent } from '../lib/agent'
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
  onOpenSetup,
}: {
  activeServerId?: string
  onClose: () => void
  onApprovalModeChange?: (mode: ApprovalMode) => void
  // 입력창에 글을 채우고 설정을 닫는다(백업 복원 요청).
  onDraft?: (text: string) => void
  // 첫 접속 설정 페이지(연결 설정)를 다시 연다. Portainer 주소·API 키를 바꿀 때.
  onOpenSetup?: () => void
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
          {sectionId === 'api-key' && <ApiKeySection onOpenSetup={onOpenSetup} />}
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

// Agent는 시작할 때 키를 읽는다. WEB이 띄운 Agent면 저장한 뒤 다시 시작한다.
const SAVED_TEXT: Record<NonNullable<Settings['agentRestart']> | 'saved', string> = {
  started: '저장했어요. 새 키로 AI Agent를 다시 켜고 있어요.',
  waiting: '저장했어요. 처리 중인 대화가 끝나면 AI Agent를 다시 켜서 새 키를 적용해요.',
  manual: '저장했어요. AI Agent를 띄운 창에서 Agent를 다시 시작해야 새 키가 적용돼요.',
  saved: '저장했어요. AI Agent를 다시 시작해야 새 키가 적용돼요.',
}

// 키는 Agent env 파일에 저장된다. 화면은 키 값을 다시 받지 않고 저장 여부만 보여준다.
// Portainer 주소·API 키는 여기서 다루지 않는다(첫 접속 설정 페이지에서 바꾼다).
function ApiKeySection({ onOpenSetup }: { onOpenSetup?: () => void }) {
  const { settings, setSettings, failed } = useSettings()
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<Settings['agentRestart'] | 'saved' | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    const apiKey = value.trim()
    if (!agent.saveApiKey || saving || !apiKey) return
    setSaving(true)
    setSaved(null)
    setSaveFailed(false)
    try {
      const next = await agent.saveApiKey(apiKey)
      setSettings(next)
      setValue('')
      setSaved(next.agentRestart ?? 'saved')
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
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-[13px]"
        />
        <button type="submit" disabled={saving || !value.trim()} className="shrink-0 rounded-lg bg-navy-800 px-3 py-2 text-sm text-white disabled:opacity-40">
          저장
        </button>
      </div>
      {saved && <p className="px-1 text-sm text-neutral-700">{SAVED_TEXT[saved]}</p>}
      {saveFailed && <p className="px-1 text-sm text-red-600">저장하지 못했어요. 키를 확인하고 다시 시도해주세요.</p>}
      {onOpenSetup && (
        <div className="mt-1 border-t border-neutral-200 pt-2">
          <p className="px-1 text-xs text-neutral-500">
            Portainer 주소와 API 키는 연결 설정 페이지에서 바꿔요.
          </p>
          <button
            type="button"
            onClick={onOpenSetup}
            className="mt-1 rounded-md bg-neutral-200 px-3 py-1.5 text-sm text-neutral-800 hover:bg-neutral-300"
          >
            연결 설정 열기
          </button>
        </div>
      )}
    </form>
  )
}
