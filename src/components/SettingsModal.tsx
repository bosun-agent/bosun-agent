import { useEffect, useState } from 'react'
import type { Settings } from '../lib/agentProtocol'
import { agent } from '../lib/agent'

// 1차 범위(모델 선택, API 키)와 2차에 들어올 항목 자리. 모델 말고는 아직 회색 블록이다.
const SECTIONS = [
  { id: 'model', label: '모델' },
  { id: 'api-key', label: 'API 키' },
  { id: 'policy', label: '정책' },
  { id: 'about', label: '정보' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export function SettingsModal({ onClose }: { onClose: () => void }) {
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
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="설정"
        onClick={(e) => e.stopPropagation()}
        className="flex h-[min(36rem,90vh)] w-full max-w-3xl flex-col gap-1 overflow-hidden rounded-lg border border-neutral-300 bg-neutral-100 p-1 shadow-lg sm:flex-row"
      >
        <nav className="flex shrink-0 gap-1 overflow-x-auto rounded-md bg-neutral-100 p-1 sm:w-48 sm:flex-col">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSectionId(s.id)}
              className={`shrink-0 rounded-md px-3 py-1.5 text-left text-sm ${
                s.id === sectionId
                  ? 'bg-neutral-300 font-medium'
                  : 'bg-neutral-200 text-neutral-600 hover:bg-neutral-300'
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <section className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto rounded-md bg-neutral-100 p-2">
          <div className="flex items-center justify-between">
            <h2 className="rounded-md bg-neutral-200 px-3 py-1 text-sm font-medium">
              {section.label}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="설정 닫기"
              className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-200"
            >
              ✕
            </button>
          </div>
          {sectionId === 'model' ? (
            <ModelSection />
          ) : (
            <>
              <div aria-hidden className="h-40 shrink-0 rounded-md bg-neutral-300/70" />
              <div aria-hidden className="h-10 shrink-0 rounded-md bg-neutral-300/70" />
              <div aria-hidden className="h-40 shrink-0 rounded-md bg-neutral-300/70" />
            </>
          )}
        </section>
      </div>
    </div>
  )
}

// 고르면 바로 저장한다. 다음 메시지부터 그 모델로 보낸다.
function ModelSection() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!agent.getSettings) {
      setFailed(true)
      return
    }
    agent.getSettings().then(setSettings, () => setFailed(true))
  }, [])

  async function choose(model: string) {
    if (!agent.saveModel || saving) return
    setSaving(true)
    setFailed(false)
    try {
      setSettings(await agent.saveModel(model))
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  if (failed && !settings) {
    return <p className="px-1 text-sm text-red-600">설정을 불러오지 못했어요.</p>
  }
  if (!settings) return <p className="px-1 text-sm text-neutral-500">불러오는 중…</p>
  if (settings.models.length === 0) {
    return (
      <p className="px-1 text-sm text-neutral-500">
        고를 수 있는 모델이 없어요. AI Agent 설정에 적힌 모델을 써요.
      </p>
    )
  }

  return (
    <div className="space-y-1.5">
      <p className="px-1 text-xs text-neutral-500">다음 메시지부터 고른 모델로 답해요.</p>
      {settings.models.map((model) => (
        <label
          key={model}
          className="flex cursor-pointer items-center gap-2 rounded-md bg-white px-3 py-2 text-sm hover:bg-neutral-50"
        >
          <input
            type="radio"
            name="model"
            checked={settings.model === model}
            disabled={saving}
            onChange={() => choose(model)}
          />
          <span className="font-mono text-[13px]">{model}</span>
        </label>
      ))}
      {failed && <p className="px-1 text-sm text-red-600">저장하지 못했어요. 다시 골라주세요.</p>}
    </div>
  )
}
