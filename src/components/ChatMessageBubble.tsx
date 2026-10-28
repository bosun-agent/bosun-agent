import { useState, type KeyboardEvent } from 'react'
import { blockResolved } from '../lib/processSteps'
import type { ChatMessage, MessageStatus } from '../types'
import { ApprovalCard } from './ApprovalCard'
import { Markdown } from './Markdown'
import { ProcessSteps } from './ProcessSteps'
import { RejectedNotice } from './RejectedNotice'

interface ChatMessageBubbleProps {
  message: ChatMessage
  onApprove?: (id: string) => void
  onDeny?: (id: string) => void
  onExpire?: (id: string) => void
  onEdit?: (id: string, text: string) => void
  onRetry?: (id: string) => void
}

// 이 상태에서는 처리 과정을 펼쳐서 실시간으로 보여준다.
const LIVE_STATUSES: MessageStatus[] = ['thinking', 'streaming', 'pending_approval']

// 첨부 파일이 붙은 긴 메시지는 접어서 보여준다.
const FOLD_CHARS = 600

export function ChatMessageBubble({ message, onApprove, onDeny, onExpire, onEdit, onRetry }: ChatMessageBubbleProps) {
  if (message.role === 'user') return <UserBubble message={message} onEdit={onEdit} />

  const steps = message.steps ?? []
  const settled = !LIVE_STATUSES.includes(message.status)

  return (
    <div className="group flex flex-col items-start">
      <ProcessSteps steps={steps} live={!settled} />
      {message.rejectionReason && (
        <div className="mb-2 w-full">
          <RejectedNotice reason={message.rejectionReason} details={message.rejectionDetails} resolved={blockResolved(steps)} />
        </div>
      )}
      <AssistantBody message={message} hasSteps={steps.length > 0} onApprove={onApprove} onDeny={onDeny} onExpire={onExpire} />
      {message.notice && <p className="mt-1 text-xs text-neutral-500">{message.notice}</p>}
      {settled && (message.content || (message.status === 'error' && onRetry)) && (
        <div className="mt-1 flex gap-1 text-xs text-neutral-400 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
          {message.content && <CopyButton text={message.content} />}
          {message.status === 'error' && onRetry && (
            <button type="button" onClick={() => onRetry(message.id)} className="rounded px-1.5 py-0.5 hover:bg-neutral-100 hover:text-neutral-700">
              다시 시도
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function UserBubble({ message, onEdit }: Pick<ChatMessageBubbleProps, 'message' | 'onEdit'>) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [unfolded, setUnfolded] = useState(false)
  const long = message.content.length > FOLD_CHARS

  function submit() {
    const text = draft.trim()
    if (!text || !onEdit) return
    setEditing(false)
    if (text !== message.content) onEdit(message.id, text)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
    if (e.key === 'Escape') setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex justify-end">
        <div className="w-full max-w-[75%] space-y-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            rows={Math.min(8, draft.split('\n').length + 1)}
            aria-label="메시지 고치기"
            className="w-full resize-y rounded-2xl border border-neutral-400 px-4 py-2.5 text-[15px] leading-relaxed outline-none"
          />
          <p className="text-right text-[11px] text-neutral-500">고쳐 보내면 이 메시지 앞까지 복사한 새 대화에서 다시 시작해요.</p>
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={() => setEditing(false)} className="rounded-lg border border-neutral-300 px-3 py-1 text-sm text-neutral-700">
              취소
            </button>
            <button type="button" onClick={submit} disabled={!draft.trim()} className="rounded-lg bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-40">
              새 대화로 보내기
            </button>
          </div>
        </div>
      </div>
    )
  }

  const shown = long && !unfolded ? `${message.content.slice(0, FOLD_CHARS)}…` : message.content
  return (
    <div className="group flex flex-col items-end">
      <div className="max-w-[75%] rounded-2xl bg-neutral-900 px-4 py-2.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap text-white">
        {shown}
        {long && (
          <button type="button" onClick={() => setUnfolded((v) => !v)} className="mt-1 block text-xs text-neutral-300 underline">
            {unfolded ? '접기' : `전체 보기 (${message.content.length.toLocaleString()}자)`}
          </button>
        )}
      </div>
      <div className="mt-1 flex gap-1 text-xs text-neutral-400 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
        <CopyButton text={message.content} />
        {onEdit && (
          <button
            type="button"
            onClick={() => {
              setDraft(message.content)
              setEditing(true)
            }}
            className="rounded px-1.5 py-0.5 hover:bg-neutral-100 hover:text-neutral-700"
          >
            수정
          </button>
        )}
      </div>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 클립보드를 쓸 수 없는 환경(HTTP 원격 접속 등)
    }
  }
  return (
    <button type="button" onClick={copy} className="rounded px-1.5 py-0.5 hover:bg-neutral-100 hover:text-neutral-700">
      {copied ? '복사함' : '복사'}
    </button>
  )
}

function AssistantBody({
  message,
  hasSteps,
  onApprove,
  onDeny,
  onExpire,
}: Pick<ChatMessageBubbleProps, 'message' | 'onApprove' | 'onDeny' | 'onExpire'> & { hasSteps: boolean }) {
  if ((message.status === 'pending_approval' || message.status === 'approval_expired') && message.approval) {
    const expired = message.status === 'approval_expired'
    return (
      <div className="flex w-full flex-col items-start gap-2">
        {/* 카드를 띄우기 전에 Agent가 한 말(무엇을 왜 하려는지) */}
        {!expired && message.content && (
          <div className="max-w-[75%] rounded-2xl bg-neutral-100 px-4 py-2.5 text-[15px] leading-relaxed text-neutral-900">
            <Markdown text={message.content} />
          </div>
        )}
        <ApprovalCard
          approval={message.approval}
          expired={expired}
          onApprove={() => onApprove?.(message.id)}
          onDeny={() => onDeny?.(message.id)}
          onExpire={() => onExpire?.(message.id)}
        />
        {/* 만료 뒤 Agent가 이어서 한 말 */}
        {expired && message.content && (
          <div className="max-w-[75%] rounded-2xl bg-neutral-100 px-4 py-2.5 text-[15px] leading-relaxed text-neutral-900">
            <Markdown text={message.content} />
          </div>
        )}
      </div>
    )
  }

  if (message.status === 'error') {
    return (
      <div className="max-w-[75%] rounded-2xl border border-neutral-300 px-4 py-2.5 text-[15px] leading-relaxed text-neutral-600">
        {/* 끊기기 전까지 받은 내용은 남기고, 그 아래에 오류를 붙인다 */}
        {message.content && (
          <div className="mb-1.5 text-neutral-900">
            <Markdown text={message.content} />
          </div>
        )}
        <p className={message.content ? 'text-sm text-red-600' : ''}>{message.errorMessage ?? '알 수 없는 오류가 발생했어요.'}</p>
      </div>
    )
  }

  // 처리 과정이 보이는 동안에는 빈 말풍선에 점 애니메이션을 따로 띄우지 않는다.
  if (message.status === 'thinking' && !message.content) {
    return hasSteps ? null : (
      <div className="rounded-2xl bg-neutral-100 px-4 py-2.5">
        <TypingDots />
      </div>
    )
  }

  if (!message.content) return null

  return (
    <div className="max-w-[75%] rounded-2xl bg-neutral-100 px-4 py-2.5 text-[15px] leading-relaxed text-neutral-900">
      <Markdown text={message.content} />
      {message.status === 'streaming' && <StreamCursor />}
    </div>
  )
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400" style={{ animationDelay: `${i * 0.12}s` }} />
      ))}
    </span>
  )
}

function StreamCursor() {
  return <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-current align-middle" />
}
