import { useEffect, useRef } from 'react'
import type { ChatMessage } from '../types'
import { ChatMessageBubble } from './ChatMessageBubble'

interface MessageListProps {
  messages: ChatMessage[]
  onApprove?: (id: string) => void
  onDeny?: (id: string) => void
  onExpire?: (id: string) => void
}

export function MessageList({
  messages,
  onApprove,
  onDeny,
  onExpire,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-3 px-4 pt-14 pb-6">
        {messages.map((message) => (
          <ChatMessageBubble
            key={message.id}
            message={message}
            onApprove={onApprove}
            onDeny={onDeny}
            onExpire={onExpire}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
