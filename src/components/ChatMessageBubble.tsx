import type { ChatMessage, ToolStatus } from '../types'
import { ApprovalCard } from './ApprovalCard'
import { RejectedNotice } from './RejectedNotice'

interface ChatMessageBubbleProps {
  message: ChatMessage
  onApprove?: (id: string) => void
  onDeny?: (id: string) => void
  onExpire?: (id: string) => void
}

export function ChatMessageBubble({
  message,
  onApprove,
  onDeny,
  onExpire,
}: ChatMessageBubbleProps) {
  const isUser = message.role === 'user'

  if (
    (message.status === 'pending_approval' ||
      message.status === 'approval_expired') &&
    message.approval
  ) {
    return (
      <div className="flex justify-start">
        <ApprovalCard
          approval={message.approval}
          expired={message.status === 'approval_expired'}
          onApprove={() => onApprove?.(message.id)}
          onDeny={() => onDeny?.(message.id)}
          onExpire={() => onExpire?.(message.id)}
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
        <div className="max-w-[75%] rounded-2xl border border-neutral-300 px-4 py-2.5 text-[15px] leading-relaxed text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
          {/* 끊기기 전까지 받은 내용은 남기고, 그 아래에 오류를 붙인다 */}
          {message.content && (
            <p className="mb-1.5 whitespace-pre-wrap text-neutral-900 dark:text-neutral-100">
              {message.content}
            </p>
          )}
          <p
            className={
              message.content ? 'text-sm text-red-600 dark:text-red-400' : ''
            }
          >
            {message.errorMessage ?? '알 수 없는 오류가 발생했어요.'}
          </p>
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
        {message.toolStatus && <ToolStatusLine toolStatus={message.toolStatus} />}
      </div>
    </div>
  )
}

const TOOL_STATUS_STYLE: Record<ToolStatus['status'], string> = {
  running: 'text-neutral-500 dark:text-neutral-400',
  succeeded: 'text-emerald-600 dark:text-emerald-400',
  failed: 'text-red-600 dark:text-red-400',
}

const TOOL_STATUS_ICON: Record<ToolStatus['status'], string> = {
  running: '…',
  succeeded: '✓',
  failed: '✕',
}

function ToolStatusLine({ toolStatus }: { toolStatus: ToolStatus }) {
  return (
    <p className={`mt-1 text-xs ${TOOL_STATUS_STYLE[toolStatus.status]}`}>
      {TOOL_STATUS_ICON[toolStatus.status]} {toolStatus.summary}
    </p>
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
