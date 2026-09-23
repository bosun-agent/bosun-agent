import { useState } from 'react'
import type { KeyboardEvent } from 'react'

interface ChatInputProps {
  disabled?: boolean
  onSend: (text: string) => void
}

export function ChatInput({ disabled, onSend }: ChatInputProps) {
  const [value, setValue] = useState('')

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
    <div className="border-t border-neutral-200 p-3 dark:border-neutral-800 sm:p-4">
      <div className="flex items-end gap-2 rounded-2xl border border-neutral-200 bg-white p-2 dark:border-neutral-700 dark:bg-neutral-900">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
          placeholder="컨테이너에게 시킬 일을 말해보세요..."
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] outline-none placeholder:text-neutral-400 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !value.trim()}
          className="shrink-0 rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
        >
          전송
        </button>
      </div>
    </div>
  )
}
