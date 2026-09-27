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

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-neutral-400">
        <p className="max-w-sm text-sm">
          "웹사이트 하나 띄워줘" 처럼, 원하는 작업을 말로 설명해보세요.
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 space-y-3 overflow-y-auto px-4 py-6 sm:px-6">
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
  )
}
