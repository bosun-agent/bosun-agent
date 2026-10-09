import { useEffect, useState } from 'react'
import { ChatInput } from './components/ChatInput'
import { DevScenarioBar } from './components/DevScenarioBar'
import { MessageList } from './components/MessageList'
import { SessionSidebar, SidebarToggle } from './components/SessionSidebar'
import { SettingsModal } from './components/SettingsModal'
import type { AgentEvent, ApprovalDecision, ProgressStep } from './lib/agentProtocol'
import { agent, usingMock } from './lib/agent'
import { finishActive, hasActive, startStep } from './lib/processSteps'
import { toChatMessages } from './lib/restore'
import type { ChatMessage, ChatSession, ProcessStep } from './types'

const PROGRESS_LABEL: Record<ProgressStep, { label: string; doneLabel: string }> = {
  loading_tools: { label: '도구 목록 불러오는 중', doneLabel: '도구 목록 불러옴' },
  understanding: { label: '요청 이해하는 중', doneLabel: '요청 이해함' },
}

const TITLE_MAX = 30

// Home의 "Go to Portainer" 버튼이 여는 주소. 정하지 않으면 버튼을 비활성으로 둔다.
const PORTAINER_URL: string | undefined = import.meta.env.VITE_PORTAINER_URL

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
  const [settingsOpen, setSettingsOpen] = useState(false)

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0]

  // 서버에 있는 대화 목록을 사이드바에 붙인다. 내용은 대화를 고를 때 불러온다. 목업에는 목록이 없다.
  useEffect(() => {
    const listSessions = agent.listSessions
    if (!listSessions) return
    let cancelled = false
    listSessions()
      .then((list) => {
        if (cancelled) return
        setSessions((prev) => {
          const known = new Set(prev.map((s) => s.serverId))
          const restored = list
            .filter((s) => !known.has(s.sessionId))
            .map((s) => ({
              id: crypto.randomUUID(),
              serverId: s.sessionId,
              loaded: false,
              title: s.title || '제목 없음',
              messages: [],
            }))
          return [...prev, ...restored]
        })
      })
      .catch(() => {
        // 목록을 못 불러와도 새 대화는 쓸 수 있다.
      })
    return () => {
      cancelled = true
    }
  }, [])

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
            // 앞에 받은 내용이 없으면 맨 앞 줄바꿈은 버린다(복원된 카드를 승인한 뒤 등).
            content += content ? event.delta : event.delta.replace(/^\n+/, '')
            // 차단·만료 뒤에 오는 Agent 설명은 그 카드와 같이 보여준다(계약 6장).
            updateMessage(id, (m) => ({
              status:
                m.status === 'rejected' || m.status === 'approval_expired'
                  ? m.status
                  : 'streaming',
              content,
            }))
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
              // 만료 거부가 늦어 이미 처리된 경우(409)에는 만료 카드를 그대로 둔다.
              status: m.status === 'approval_expired' ? m.status : 'error',
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

    let serverId: string
    try {
      serverId = await getServerId(session)
    } catch {
      updateMessage(assistantId, () => ({
        status: 'error',
        errorMessage: '대화를 시작하지 못했어요. 잠시 후 다시 시도해주세요.',
      }))
      setBusyId(null)
      return
    }
    await consume(assistantId, agent.sendMessage(serverId, text))
  }

  // 승인 대기 시간이 지나면 카드를 만료로 바꾸고, 서버에 만료 거부를 보내 Agent의 이어지는 말을 받는다.
  // 입력 잠금은 그 스트림이 끝날 때 푼다(계약 6장).
  async function handleExpire(id: string) {
    const session = sessions.find((s) => s.messages.some((m) => m.id === id))
    const message = session?.messages.find((m) => m.id === id)
    updateMessage(id, (m) =>
      m.status === 'pending_approval'
        ? {
            status: 'approval_expired',
            steps: finishActive(m.steps ?? [], 'stopped', '승인 시간이 지나 취소됨'),
          }
        : {},
    )
    if (!session?.serverId || !message?.approval) {
      setBusyId(null)
      return
    }
    await consume(
      id,
      agent.sendDecision(session.serverId, message.approval.approvalId, 'deny', 'expired'),
      message.content ? `${message.content}
` : '',
    )
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
          // 승인 뒤 도구 실행 줄은 Agent가 보내는 tool_status로 붙는다.
          decision === 'approve'
            ? finishActive(steps, 'done', '승인함')
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
    // 비어 있는 대화가 이미 있으면 새로 만들지 않고 그리로 간다. 아직 안 불러온 서버 대화는 빼고 본다.
    const empty = sessions.find((s) => s.messages.length === 0 && !s.serverId)
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

    const session = sessions.find((s) => s.id === id)
    const loadMessages = agent.loadMessages
    if (!session?.serverId || session.loaded !== false || !loadMessages) return
    patchSession(id, (s) => ({ ...s, loaded: true }))
    loadMessages(session.serverId)
      .then((restored) => {
        const messages = toChatMessages(restored)
        patchSession(id, (s) => ({ ...s, messages }))
        // 결정하지 않은 승인 카드가 있으면 그 대화가 처리 중이다.
        if (messages.some((m) => m.status === 'pending_approval')) setBusyId(id)
      })
      .catch(() => {
        patchSession(id, (s) => ({ ...s, loaded: false }))
      })
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
      {/* Home에서는 와이어프레임대로 입력창 바로 아래에 Portainer 버튼을 둔다. */}
      {!isEmpty && (
        <p className="py-2 text-center text-xs text-neutral-400">
          AI는 실수할 수 있어요. 승인 카드의 내용을 꼭 확인해주세요.
        </p>
      )}
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
          <div className="flex flex-1 flex-col items-center justify-center gap-4">
            {/* 로고 이미지를 받으면 이 자리를 <img>로 바꾼다. */}
            <div className="flex h-36 w-56 items-end justify-center rounded-md border border-dashed border-neutral-300 pb-3 text-4xl font-black tracking-tight">
              BOSUN
            </div>
            {composer}
            {PORTAINER_URL ? (
              <a
                href={PORTAINER_URL}
                target="_blank"
                rel="noreferrer"
                className="rounded-full bg-neutral-100 px-8 py-1 text-xs text-neutral-600 hover:bg-neutral-200"
              >
                Go to Portainer
              </a>
            ) : (
              <span
                title="VITE_PORTAINER_URL을 정하면 열린다"
                className="cursor-not-allowed rounded-full bg-neutral-100 px-8 py-1 text-xs text-neutral-400"
              >
                Go to Portainer
              </span>
            )}
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

        {/* 입력창 옆에 자리가 모자라면 겹치지 않게 오른쪽 위에 둔다. 사이드바를 연 md~lg 폭도 모자란다. */}
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="설정"
          className={`absolute top-3 right-3 flex h-8 w-8 items-center justify-center rounded-md text-neutral-700 hover:bg-neutral-100 lg:top-auto ${
            import.meta.env.DEV && usingMock ? 'lg:bottom-14' : 'lg:bottom-3'
          }`}
        >
          <GearIcon />
        </button>

        {import.meta.env.DEV && usingMock && (
          <DevScenarioBar disabled={busyId !== null} onRun={handleSend} />
        )}
      </main>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

function GearIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

export default App
