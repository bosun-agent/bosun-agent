import { useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react'

interface ChatInputProps {
  disabled?: boolean
  // 처음 채울 글(도움말 예시). 바깥에서 key를 바꿔 다시 그리면 그 글로 채운다.
  initialText?: string
  onSend: (text: string) => void
  // 처리 중일 때 전송 버튼 자리에 멈춤 버튼을 둔다.
  onStop?: () => void
  // 전송 버튼 왼쪽에 두는 것(모델 선택)
  extra?: ReactNode
}

interface Attachment {
  name: string
  text: string
}

// 첨부는 텍스트 파일만 받는다(compose 파일, 로그, 설정). 내용은 메시지에 코드 블록으로 붙는다.
const MAX_FILE_BYTES = 50_000
const MAX_FILES = 3

export function ChatInput({ disabled, initialText, onSend, onStop, extra }: ChatInputProps) {
  const [value, setValue] = useState(initialText ?? '')
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
      <div className="relative flex items-end gap-1 rounded-3xl border border-neutral-300 bg-white px-2 py-1.5 shadow-[0_1px_3px_rgb(16_33_60/0.07)] transition-colors focus-within:border-navy-600">
        {/* 도움말은 사이드바 아래로 옮겨서(2026-11-11 회의) + 는 바로 파일 고르기다. */}
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          aria-label="첨부"
          title="텍스트 파일 붙이기 (compose, 로그, 설정 파일)"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-700 hover:bg-neutral-100"
        >
          <PlusIcon />
        </button>
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
          placeholder="무엇을 해 드릴까요?"
          className="max-h-40 min-w-0 flex-1 resize-none bg-transparent px-1 py-[5px] text-[15px] leading-[22px] outline-none placeholder:text-neutral-400 disabled:opacity-50"
        />
        {extra}
        {disabled && onStop ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="멈추기"
            title="처리 중인 작업 멈추기"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-800 text-white hover:bg-navy-700"
          >
            <span className="h-2.5 w-2.5 rounded-[2px] bg-white" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label="전송"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-800 text-white transition-colors hover:bg-navy-700 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400"
          >
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  )
}

// 글자 "+"는 글꼴 기준선 때문에 아래로 처져 보여서 그림으로 그린다. 한 줄일 때 입력란 높이(32px)와 버튼 높이를 맞춘다.
function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  )
}
