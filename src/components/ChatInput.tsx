import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

interface ChatInputProps {
  disabled?: boolean
  onSend: (text: string) => void
}

export function ChatInput({ disabled, onSend }: ChatInputProps) {
  const [value, setValue] = useState('')
  const [attachOpen, setAttachOpen] = useState(false)

  function submit() {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setValue('')
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="relative flex items-end gap-1 rounded-3xl border border-neutral-400 bg-white px-2 py-1.5">
      <button
        type="button"
        onClick={() => setAttachOpen((open) => !open)}
        aria-label="첨부"
        aria-expanded={attachOpen}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-lg text-neutral-700 hover:bg-neutral-100"
      >
        +
      </button>
      {attachOpen && <AttachMenu onClose={() => setAttachOpen(false)} />}
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        rows={1}
        placeholder="What's on your mind?"
        className="max-h-40 flex-1 resize-none bg-transparent px-1 py-1.5 text-[15px] outline-none placeholder:text-neutral-400 disabled:opacity-50"
      />
      <button
        type="button"
        onClick={submit}
        disabled={disabled || !value.trim()}
        aria-label="전송"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <SearchIcon />
      </button>
    </div>
  )
}

// 입력창 + 버튼 위에 뜨는 첨부 메뉴. 레이아웃만 잡아둔 단계라 항목은 아직 동작하지 않는다.
function AttachMenu({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      // + 버튼을 누른 경우는 버튼 쪽 토글에 맡긴다.
      const target = e.target as HTMLElement
      if (ref.current?.contains(target) || target.closest('[aria-label="첨부"]')) return
      onClose()
    }
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-2 z-20 mb-1.5 w-44 rounded-lg border border-neutral-300 bg-white p-2 shadow-md"
    >
      <p className="px-1 pb-1 text-[11px] font-medium tracking-wide text-neutral-500">
        ATTACH
      </p>
      <MenuItem icon="📄" label="Files" />
      <MenuItem icon="📁" label="Folder" />
      <hr className="my-1.5 border-neutral-200" />
      <div aria-hidden className="space-y-1.5 px-1 pb-0.5">
        <div className="h-5 rounded-full bg-neutral-200" />
        <div className="h-5 rounded-full bg-neutral-200" />
      </div>
    </div>
  )
}

function MenuItem({ icon, label }: { icon: string; label: string }) {
  return (
    <button
      type="button"
      disabled
      title="준비 중"
      className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm text-neutral-700 disabled:cursor-not-allowed"
    >
      <span className="text-xs">{icon}</span>
      {label}
    </button>
  )
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}
