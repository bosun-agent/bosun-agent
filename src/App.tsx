import { useState } from 'react'
import { ChatInput } from './components/ChatInput'
import { MessageList } from './components/MessageList'
import { askAgent } from './lib/mockAgent'
import type { ChatMessage } from './types'

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pending, setPending] = useState(false)

  function updateMessage(id: string, patch: Partial<ChatMessage>) {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    )
  }

  // 단어 단위로 점진적으로 채워서 스트리밍처럼 보여준다. 완료되면 status를 'done'으로.
  async function streamReply(id: string, text: string) {
    const words = text.split(' ')
    updateMessage(id, { status: 'streaming', content: '' })
    for (let i = 1; i <= words.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 45))
      updateMessage(id, { content: words.slice(0, i).join(' ') })
    }
    updateMessage(id, { status: 'done' })
  }

  async function handleSend(text: string) {
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      status: 'done',
    }
    const assistantId = crypto.randomUUID()
    const assistantPlaceholder: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      status: 'thinking',
    }

    setMessages((prev) => [...prev, userMessage, assistantPlaceholder])
    setPending(true)

    const result = await askAgent(text)

    if (result.type === 'reply') {
      await streamReply(assistantId, result.text)
      setPending(false)
      return
    }

    if (result.type === 'rejected') {
      updateMessage(assistantId, {
        status: 'rejected',
        rejectionReason: result.reason,
      })
      setPending(false)
      return
    }

    // approval_required — 사용자가 승인/거부할 때까지 입력을 막아둔다.
    updateMessage(assistantId, {
      status: 'pending_approval',
      approval: { summary: result.summary, details: result.details },
    })
  }

  async function handleApprove(id: string) {
    updateMessage(id, { approval: undefined })
    await streamReply(
      id,
      '승인해주셔서 진행할게요. 요청하신 작업을 실행했어요. (목업 응답)',
    )
    setPending(false)
  }

  function handleDeny(id: string) {
    updateMessage(id, {
      status: 'done',
      content: '요청을 취소했어요.',
      approval: undefined,
    })
    setPending(false)
  }

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="border-b border-neutral-200 px-4 py-3 dark:border-neutral-800 sm:px-6">
        <h1 className="text-lg font-semibold">BOSUN</h1>
        <p className="text-xs text-neutral-400">말로 컨테이너를 관리하세요</p>
      </header>

      <MessageList
        messages={messages}
        onApprove={handleApprove}
        onDeny={handleDeny}
      />
      <ChatInput disabled={pending} onSend={handleSend} />
    </div>
  )
}

export default App
