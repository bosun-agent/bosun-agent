import type { ChatMessage, MessageStatus } from '../types'
import { ApprovalCard } from './ApprovalCard'
import { ProcessSteps } from './ProcessSteps'
import { RejectedNotice } from './RejectedNotice'

interface ChatMessageBubbleProps {
  message: ChatMessage
  onApprove?: (id: string) => void
  onDeny?: (id: string) => void
  onExpire?: (id: string) => void
}

// 이 상태에서는 처리 과정을 펼쳐서 실시간으로 보여준다.
const LIVE_STATUSES: MessageStatus[] = ['thinking', 'streaming', 'pending_approval']

export function ChatMessageBubble({
  message,
  onApprove,
  onDeny,
  onExpire,
}: ChatMessageBubbleProps) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl bg-neutral-900 px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-white">
          {message.content}
        </div>
      </div>
    )
  }

  const steps = message.steps ?? []

  return (
    <div className="flex flex-col items-start">
      <ProcessSteps
        steps={steps}
        live={LIVE_STATUSES.includes(message.status)}
      />
      <AssistantBody
        message={message}
        hasSteps={steps.length > 0}
        onApprove={onApprove}
        onDeny={onDeny}
        onExpire={onExpire}
      />
    </div>
  )
}

function AssistantBody({
  message,
  hasSteps,
  onApprove,
  onDeny,
  onExpire,
}: ChatMessageBubbleProps & { hasSteps: boolean }) {
  if (
    (message.status === 'pending_approval' ||
      message.status === 'approval_expired') &&
    message.approval
  ) {
    const expired = message.status === 'approval_expired'
    return (
      <div className="flex w-full flex-col items-start gap-2">
        <ApprovalCard
          approval={message.approval}
          expired={expired}
          onApprove={() => onApprove?.(message.id)}
          onDeny={() => onDeny?.(message.id)}
          onExpire={() => onExpire?.(message.id)}
        />
        {/* 만료 뒤 Agent가 이어서 한 말 */}
        {expired && message.content && (
          <div className="max-w-[75%] rounded-2xl bg-neutral-100 px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-neutral-900">
            {message.content}
          </div>
        )}
      </div>
    )
  }

  if (message.status === 'rejected') {
    return (
      <RejectedNotice
        reason={message.rejectionReason ?? '알 수 없는 이유로 차단되었습니다.'}
        detail={message.content}
      />
    )
  }

  if (message.status === 'error') {
    return (
      <div className="max-w-[75%] rounded-2xl border border-neutral-300 px-4 py-2.5 text-[15px] leading-relaxed text-neutral-600">
        {/* 끊기기 전까지 받은 내용은 남기고, 그 아래에 오류를 붙인다 */}
        {message.content && (
          <p className="mb-1.5 whitespace-pre-wrap text-neutral-900">
            {message.content}
          </p>
        )}
        <p className={message.content ? 'text-sm text-red-600' : ''}>
          {message.errorMessage ?? '알 수 없는 오류가 발생했어요.'}
        </p>
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
    <div className="max-w-[75%] rounded-2xl bg-neutral-100 px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-neutral-900">
      {message.content}
      {message.status === 'streaming' && <StreamCursor />}
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
