import { useState } from 'react'
import { ChatInput } from './components/ChatInput'
import { DevScenarioBar } from './components/DevScenarioBar'
import { MessageList } from './components/MessageList'
import { SessionSidebar, SidebarToggle } from './components/SessionSidebar'
import type { AgentEvent, ApprovalDecision, ProgressStep } from './lib/agentProtocol'
import { mockAgent as agent } from './lib/mockAgent'
import { finishActive, hasActive, startStep } from './lib/processSteps'
import type { ChatMessage, ChatSession, ProcessStep } from './types'

const PROGRESS_LABEL: Record<ProgressStep, { label: string; doneLabel: string }> = {
  loading_tools: { label: '도구 목록 불러오는 중', doneLabel: '도구 목록 불러옴' },
  understanding: { label: '요청 이해하는 중', doneLabel: '요청 이해함' },
}

const TITLE_MAX = 30

// 좁은 화면에서는 사이드바가 채팅 위에 겹치므로, 대화를 고르면 닫는다. Tailwind md 기준과 같다.
const isNarrowScreen = () => !window.matchMedia('(min-width: 768px)').matches

function newSession(): ChatSession {
  return { id: crypto.randomUUID(), title: '새 대화', messages: [] }
}

function App() {
  const [sessions, setSessions] = useState<ChatSession[]>(() => [newSession()])
  const [activeId, setActiveId] = useState(() => sessions[0].id)
  // 처리 중인 대화. 백엔드가 Agent 스트림을 하나만 열기 때문에 한 번에 한 대화만 처리한다(인터페이스 계약 3장).
  const [busyId, setBusyId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0]

  function patchSession(id: string, fn: (s: ChatSession) => ChatSession) {
    setSessions((prev) => prev.map((s) => (s.id === id ? fn(s) : s)))
  }

  // 메시지 id는 모든 대화에서 고유하므로, 처리 도중 다른 대화로 옮겨도 원래 메시지가 갱신된다.
  function updateMessage(
    id: string,
    fn: (m: ChatMessage) => Partial<ChatMessage>,
  ) {
    setSessions((prev) =>
      prev.map((s) =>
        s.messages.some((m) => m.id === id)
          ? {
              ...s,
              messages: s.messages.map((m) =>
                m.id === id ? { ...m, ...fn(m) } : m,
              ),
            }
          : s,
      ),
    )
  }

  function updateSteps(id: string, fn: (steps: ProcessStep[]) => ProcessStep[]) {
    updateMessage(id, (m) => ({ steps: fn(m.steps ?? []) }))
  }

  async function getServerId(session: ChatSession) {
    if (session.serverId) return session.serverId
    const serverId = await agent.createSession()
    patchSession(session.id, (s) => ({ ...s, serverId }))
    return serverId
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
          case 'progress':
            updateSteps(id, (steps) =>
              startStep(steps, PROGRESS_LABEL[event.step]),
            )
            break
          case 'text_delta':
            content += event.delta
            updateMessage(id, () => ({ status: 'streaming', content }))
            break
          case 'tool_status':
            updateSteps(id, (steps) => {
              if (event.status === 'running') {
                return startStep(steps, {
                  label: event.summary,
                  doneLabel: '도구 호출함',
                  detail: event.tool,
                })
              }
              const state = event.status === 'succeeded' ? 'done' : 'failed'
              // 진행 중인 단계가 없었으면 결과를 새 줄로 남긴다.
              return hasActive(steps)
                ? finishActive(steps, state, event.summary)
                : [
                    ...steps,
                    { id: crypto.randomUUID(), label: event.summary, detail: event.tool, state },
                  ]
            })
            break
          case 'approval_required':
            awaitingApproval = true
            updateMessage(id, (m) => ({
              status: 'pending_approval',
              approval: {
                approvalId: event.approvalId,
                summary: event.summary,
                action: event.action,
                reasons: event.reasons,
                expiresAt: event.expiresAt,
              },
              steps: startStep(m.steps ?? [], {
                label: '사용자 승인 기다리는 중',
              }),
            }))
            break
          case 'rejected':
            updateMessage(id, (m) => ({
              status: 'rejected',
              rejectionReason: event.reason,
              // 진행 중이던 단계는 끝난 것으로 두고, 차단을 따로 한 줄 남긴다.
              steps: finishActive(
                startStep(m.steps ?? [], { label: '정책에 따라 차단됨' }),
                'failed',
              ),
            }))
            break
          case 'error':
            updateMessage(id, (m) => ({
              status: 'error',
              errorMessage: event.message,
              steps: finishActive(m.steps ?? [], 'failed'),
            }))
            break
          case 'done':
            updateMessage(id, (m) => ({
              status:
                m.status === 'streaming' || m.status === 'thinking'
                  ? 'done'
                  : m.status,
              steps: finishActive(m.steps ?? [], 'done'),
            }))
            break
        }
      }
    } catch {
      updateMessage(id, (m) => ({
        status: 'error',
        errorMessage: 'AI Agent와 연결이 끊겼어요. 잠시 후 다시 시도해주세요.',
        steps: finishActive(m.steps ?? [], 'failed'),
      }))
    }

    if (!awaitingApproval) setBusyId(null)
  }

  async function handleSend(text: string) {
    const session = active
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

    patchSession(session.id, (s) => ({
      ...s,
      // 첫 메시지로 대화 제목을 정한다.
      title:
        s.messages.length === 0
          ? text.length > TITLE_MAX
            ? `${text.slice(0, TITLE_MAX)}…`
            : text
          : s.title,
      messages: [...s.messages, userMessage, assistantPlaceholder],
    }))
    setBusyId(session.id)

    const serverId = await getServerId(session)
    await consume(assistantId, agent.sendMessage(serverId, text))
  }

  // 승인 대기 시간이 지나면 카드를 만료 상태로 바꾸고 입력을 다시 연다.
  function handleExpire(id: string) {
    updateMessage(id, (m) =>
      m.status === 'pending_approval'
        ? {
            status: 'approval_expired',
            steps: finishActive(m.steps ?? [], 'stopped', '승인 시간이 지나 취소됨'),
          }
        : {},
    )
    setBusyId(null)
  }

  async function handleDecision(id: string, decision: ApprovalDecision) {
    const session = sessions.find((s) => s.messages.some((m) => m.id === id))
    const message = session?.messages.find((m) => m.id === id)
    if (!session?.serverId || !message?.approval) return

    const { approvalId } = message.approval
    const initialContent = message.content ? `${message.content}\n` : ''
    updateMessage(id, (m) => {
      const steps = m.steps ?? []
      return {
        status: 'thinking',
        approval: undefined,
        steps:
          decision === 'approve'
            ? startStep(finishActive(steps, 'done', '승인함'), {
                label: '승인된 작업 실행하는 중',
                doneLabel: '승인된 작업 실행함',
              })
            : finishActive(steps, 'stopped', '거부함'),
      }
    })

    await consume(
      id,
      agent.sendDecision(session.serverId, approvalId, decision),
      initialContent,
    )
  }

  function handleNewSession() {
    if (isNarrowScreen()) setSidebarOpen(false)
    // 비어 있는 대화가 이미 있으면 새로 만들지 않고 그리로 간다.
    const empty = sessions.find((s) => s.messages.length === 0)
    if (empty) {
      setActiveId(empty.id)
      return
    }
    const session = newSession()
    setSessions((prev) => [session, ...prev])
    setActiveId(session.id)
  }

  function handleSelectSession(id: string) {
    setActiveId(id)
    if (isNarrowScreen()) setSidebarOpen(false)
  }

  const busyElsewhere = busyId !== null && busyId !== active.id
  const isEmpty = active.messages.length === 0

  const composer = (
    <div className="w-full max-w-2xl px-4">
      {busyElsewhere && (
        <p className="pb-2 text-center text-xs text-neutral-500">
          다른 대화에서 작업을 처리하고 있어요. 끝나면 보낼 수 있어요.
        </p>
      )}
      <ChatInput disabled={busyId !== null} onSend={handleSend} />
      <p className="py-2 text-center text-xs text-neutral-400">
        AI는 실수할 수 있어요. 승인 카드의 내용을 꼭 확인해주세요.
      </p>
    </div>
  )

  return (
    <div className="flex h-screen bg-white text-neutral-900">
      {sidebarOpen && (
        <SessionSidebar
          sessions={sessions}
          activeId={active.id}
          busyId={busyId}
          onClose={() => setSidebarOpen(false)}
          onSelect={handleSelectSession}
          onNew={handleNewSession}
        />
      )}

      <main className="relative flex min-w-0 flex-1 flex-col">
        {!sidebarOpen && (
          <div className="absolute top-3 left-3 z-10">
            <SidebarToggle
              label="대화 목록 열기"
              onClick={() => setSidebarOpen(true)}
            />
          </div>
        )}

        {isEmpty ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-6">
            <div className="px-4 text-center">
              <p className="text-2xl font-semibold">BOSUN</p>
              <p className="mt-1 text-sm text-neutral-500">
                "웹사이트 하나 띄워줘"처럼, 원하는 작업을 말로 설명해보세요.
              </p>
            </div>
            {composer}
          </div>
        ) : (
          <>
            <MessageList
              messages={active.messages}
              onApprove={(id) => handleDecision(id, 'approve')}
              onDeny={(id) => handleDecision(id, 'deny')}
              onExpire={handleExpire}
            />
            <div className="flex justify-center">{composer}</div>
          </>
        )}

        {import.meta.env.DEV && (
          <DevScenarioBar disabled={busyId !== null} onRun={handleSend} />
        )}
      </main>
    </div>
  )
}

export default App
