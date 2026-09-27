import { useRef, useState } from 'react'
import { ChatInput } from './components/ChatInput'
import { DevScenarioBar } from './components/DevScenarioBar'
import { MessageList } from './components/MessageList'
import { ThemeToggle } from './components/ThemeToggle'
import type { AgentEvent, ApprovalDecision } from './lib/agentProtocol'
import { mockAgent as agent } from './lib/mockAgent'
import type { ChatMessage } from './types'

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pending, setPending] = useState(false)
  const sessionIdRef = useRef<string | null>(null)

  function updateMessage(id: string, patch: Partial<ChatMessage>) {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    )
  }

  async function getSessionId() {
    sessionIdRef.current ??= await agent.createSession()
    return sessionIdRef.current
  }

  // 이벤트 스트림을 메시지 하나에 반영한다. approval_required로 끝나면 입력을 계속 막아둔다.
  async function consume(
    id: string,
    events: AsyncIterable<AgentEvent>,
    initialContent = '',
  ) {
    let content = initialContent
    let awaitingApproval = false

    try {
      for await (const event of events) {
        switch (event.type) {
          case 'text_delta':
            content += event.delta
            updateMessage(id, { status: 'streaming', content })
            break
          case 'tool_status':
            updateMessage(id, {
              toolStatus: { status: event.status, summary: event.summary },
            })
            break
          case 'approval_required':
            awaitingApproval = true
            updateMessage(id, {
              status: 'pending_approval',
              approval: {
                approvalId: event.approvalId,
                summary: event.summary,
                action: event.action,
                reasons: event.reasons,
                expiresAt: event.expiresAt,
              },
            })
            break
          case 'rejected':
            updateMessage(id, {
              status: 'rejected',
              rejectionReason: event.reason,
            })
            break
          case 'error':
            updateMessage(id, { status: 'error', errorMessage: event.message })
            break
          case 'done':
            setMessages((prev) =>
              prev.map((m) =>
                m.id === id &&
                (m.status === 'streaming' || m.status === 'thinking')
                  ? { ...m, status: 'done' }
                  : m,
              ),
            )
            break
        }
      }
    } catch {
      updateMessage(id, {
        status: 'error',
        errorMessage: 'AI Agent와 연결이 끊겼어요. 잠시 후 다시 시도해주세요.',
      })
    }

    if (!awaitingApproval) setPending(false)
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

    const sessionId = await getSessionId()
    await consume(assistantId, agent.sendMessage(sessionId, text))
  }

  // 승인 대기 시간이 지나면 카드를 만료 상태로 바꾸고 입력을 다시 연다.
  function handleExpire(id: string) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id && m.status === 'pending_approval'
          ? { ...m, status: 'approval_expired' }
          : m,
      ),
    )
    setPending(false)
  }

  async function handleDecision(id: string, decision: ApprovalDecision) {
    const message = messages.find((m) => m.id === id)
    if (!message?.approval) return

    const { approvalId } = message.approval
    const initialContent = message.content ? `${message.content}\n` : ''
    updateMessage(id, { status: 'thinking', approval: undefined })

    const sessionId = await getSessionId()
    await consume(
      id,
      agent.sendDecision(sessionId, approvalId, decision),
      initialContent,
    )
  }

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800 sm:px-6">
        <div>
          <h1 className="text-lg font-semibold">BOSUN</h1>
          <p className="text-xs text-neutral-400">말로 컨테이너를 관리하세요</p>
        </div>
        <ThemeToggle />
      </header>

      <MessageList
        messages={messages}
        onApprove={(id) => handleDecision(id, 'approve')}
        onDeny={(id) => handleDecision(id, 'deny')}
        onExpire={handleExpire}
      />
      {import.meta.env.DEV && (
        <DevScenarioBar disabled={pending} onRun={handleSend} />
      )}
      <ChatInput disabled={pending} onSend={handleSend} />
    </div>
  )
}

export default App
