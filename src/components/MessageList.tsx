import { useEffect, useRef } from 'react'
import type { ChatMessage } from '../types'
import { ChatMessageBubble } from './ChatMessageBubble'

interface MessageListProps {
  messages: ChatMessage[]
  // 이 대화가 처리 중이면 수정·다시 시도를 숨긴다.
  busy?: boolean
  portainerUrl?: string
  onApprove?: (id: string) => void
  onDeny?: (id: string) => void
  onExpire?: (id: string) => void
  onEdit?: (id: string, text: string) => void
  onRetry?: (id: string) => void
}

export function MessageList({ messages, busy, portainerUrl, onApprove, onDeny, onExpire, onEdit, onRetry }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-3 px-4 pt-14 pb-6">
        {messages.map((message, i) => (
          <ChatMessageBubble
            key={message.id}
            message={message}
            portainerUrl={portainerUrl}
            onApprove={onApprove}
            onDeny={onDeny}
            onExpire={onExpire}
            onEdit={!busy ? onEdit : undefined}
            // 다시 시도는 마지막 답에만 둔다.
            onRetry={!busy && i === messages.length - 1 ? onRetry : undefined}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
