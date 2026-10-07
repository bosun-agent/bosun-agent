import { useEffect, useState } from 'react'

// 1차 범위(모델 선택, API 키)와 2차에 들어올 항목 자리. 레이아웃만 잡아둔 단계라 내용은 회색 블록이다.
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
          <div aria-hidden className="h-40 shrink-0 rounded-md bg-neutral-300/70" />
          <div aria-hidden className="h-10 shrink-0 rounded-md bg-neutral-300/70" />
          <div aria-hidden className="h-40 shrink-0 rounded-md bg-neutral-300/70" />
        </section>
      </div>
    </div>
  )
}
