import type { ChatMessage } from '../types'
import { ApprovalCard } from './ApprovalCard'
import { RejectedNotice } from './RejectedNotice'

interface ChatMessageBubbleProps {
  message: ChatMessage
  onApprove?: (id: string) => void
  onDeny?: (id: string) => void
}

export function ChatMessageBubble({
  message,
  onApprove,
  onDeny,
}: ChatMessageBubbleProps) {
  const isUser = message.role === 'user'

  if (message.status === 'pending_approval' && message.approval) {
    return (
      <div className="flex justify-start">
        <ApprovalCard
          approval={message.approval}
          onApprove={() => onApprove?.(message.id)}
          onDeny={() => onDeny?.(message.id)}
        />
      </div>
    )
  }

  if (message.status === 'rejected') {
    return (
      <div className="flex justify-start">
        <RejectedNotice
          reason={message.rejectionReason ?? '알 수 없는 이유로 차단되었습니다.'}
        />
      </div>
    )
  }

  if (message.status === 'error') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[75%] rounded-2xl border border-neutral-300 px-4 py-2.5 text-[15px] text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
          {message.errorMessage ?? '알 수 없는 오류가 발생했어요.'}
        </div>
      </div>
    )
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap ${
          isUser
            ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
            : 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
        }`}
      >
        {message.status === 'thinking' ? (
          <TypingDots />
        ) : (
          <>
            {message.content}
            {message.status === 'streaming' && <StreamCursor />}
          </>
        )}
        {message.toolStatus && (
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {message.toolStatus}
          </p>
        )}
      </div>
    </div>
  )
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400"
          style={{ animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </span>
  )
}

function StreamCursor() {
  return (
    <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-current align-middle" />
  )
}
