import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'

interface ChatInputProps {
  disabled?: boolean
  // 처음 채울 글(도움말 예시). 바깥에서 key를 바꿔 다시 그리면 그 글로 채운다.
  initialText?: string
  onSend: (text: string) => void
  // 처리 중일 때 전송 버튼 자리에 멈춤 버튼을 둔다.
  onStop?: () => void
  onHelp?: () => void
}

interface Attachment {
  name: string
  text: string
}

// 첨부는 텍스트 파일만 받는다(compose 파일, 로그, 설정). 내용은 메시지에 코드 블록으로 붙는다.
const MAX_FILE_BYTES = 50_000
const MAX_FILES = 3

export function ChatInput({ disabled, initialText, onSend, onStop, onHelp }: ChatInputProps) {
  const [value, setValue] = useState(initialText ?? '')
  const [attachOpen, setAttachOpen] = useState(false)
  const [files, setFiles] = useState<Attachment[]>([])
  const [fileError, setFileError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  function submit() {
    const trimmed = value.trim()
    if ((!trimmed && files.length === 0) || disabled) return
    const blocks = files.map((f) => `첨부 파일: ${f.name}\n\n\`\`\`\n${f.text.replace(/```/g, 'ˋˋˋ')}\n\`\`\``)
    onSend([trimmed, ...blocks].filter(Boolean).join('\n\n'))
    setValue('')
    setFiles([])
    setFileError(null)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  async function handleFiles(e: ChangeEvent<HTMLInputElement>) {
    const picked = [...(e.target.files ?? [])]
    e.target.value = ''
    setFileError(null)
    const added: Attachment[] = []
    for (const file of picked) {
      if (files.length + added.length >= MAX_FILES) {
        setFileError(`파일은 ${MAX_FILES}개까지 붙일 수 있어요.`)
        break
      }
      if (file.size > MAX_FILE_BYTES) {
        setFileError(`${file.name}: ${Math.round(MAX_FILE_BYTES / 1000)}KB보다 큰 파일은 붙일 수 없어요.`)
        continue
      }
      const text = await file.text()
      // 바이너리 파일(이미지, 압축 파일)은 텍스트로 읽으면 NUL이나 깨진 글자가 나온다.
      if (text.includes('\u0000') || text.includes('�')) {
        setFileError(`${file.name}: 텍스트 파일만 붙일 수 있어요.`)
        continue
      }
      added.push({ name: file.name, text })
    }
    if (added.length) setFiles((prev) => [...prev, ...added])
  }

  const canSend = !disabled && (value.trim() !== '' || files.length > 0)

  return (
    <div className="space-y-1.5">
      {(files.length > 0 || fileError) && (
        <div className="flex flex-wrap items-center gap-1.5 px-2">
          {files.map((f) => (
            <span key={f.name} className="flex items-center gap-1 rounded-full bg-neutral-100 py-0.5 pr-1 pl-2.5 text-xs text-neutral-700">
              <span className="max-w-40 truncate">{f.name}</span>
              <button
                type="button"
                onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}
                aria-label={`${f.name} 빼기`}
                className="flex h-4 w-4 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-300"
              >
                ✕
              </button>
            </span>
          ))}
          {fileError && <span className="text-xs text-red-600">{fileError}</span>}
        </div>
      )}
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
        {attachOpen && (
          <AttachMenu
            onClose={() => setAttachOpen(false)}
            onFile={() => {
              setAttachOpen(false)
              fileInput.current?.click()
            }}
            onHelp={
              onHelp &&
              (() => {
                setAttachOpen(false)
                onHelp()
              })
            }
          />
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".txt,.log,.yml,.yaml,.json,.env.example,.conf,.ini,.toml,.md,.csv,text/*,Dockerfile"
          onChange={handleFiles}
          className="hidden"
        />
        <textarea
          value={value}
          autoFocus={initialText !== undefined}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
          placeholder="What's on your mind?"
          className="max-h-40 flex-1 resize-none bg-transparent px-1 py-1.5 text-[15px] outline-none placeholder:text-neutral-400 disabled:opacity-50"
        />
        {disabled && onStop ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="멈추기"
            title="처리 중인 작업 멈추기"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white hover:bg-neutral-700"
          >
            <span className="h-2.5 w-2.5 rounded-[2px] bg-white" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label="전송"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SearchIcon />
          </button>
        )}
      </div>
    </div>
  )
}

// 입력창 + 버튼 위에 뜨는 메뉴. 텍스트 파일 첨부와 도움말.
function AttachMenu({ onClose, onFile, onHelp }: { onClose: () => void; onFile: () => void; onHelp?: () => void }) {
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
    <div ref={ref} className="absolute bottom-full left-2 z-20 mb-1.5 w-56 rounded-lg border border-neutral-300 bg-white p-2 shadow-md">
      <p className="px-1 pb-1 text-[11px] font-medium tracking-wide text-neutral-500">ATTACH</p>
      <MenuItem icon="📄" label="텍스트 파일 붙이기" hint="compose, 로그, 설정 파일" onClick={onFile} />
      {onHelp && (
        <>
          <hr className="my-1.5 border-neutral-200" />
          <MenuItem icon="?" label="무엇을 할 수 있나요?" hint="예시 명령과 안 되는 것" onClick={onHelp} />
        </>
      )}
    </div>
  )
}

function MenuItem({ icon, label, hint, onClick }: { icon: string; label: string; hint: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-start gap-2 rounded-md px-1 py-1 text-left hover:bg-neutral-100">
      <span className="w-4 pt-0.5 text-center text-xs">{icon}</span>
      <span>
        <span className="block text-sm text-neutral-800">{label}</span>
        <span className="block text-[11px] text-neutral-500">{hint}</span>
      </span>
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
