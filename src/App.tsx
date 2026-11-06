import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentStatusBanner } from './components/AgentStatusBanner'
import { ChatInput } from './components/ChatInput'
import { DevScenarioBar } from './components/DevScenarioBar'
import { HelpPanel } from './components/HelpPanel'
import { MessageList } from './components/MessageList'
import { SessionSidebar, SidebarToggle } from './components/SessionSidebar'
import { SettingsModal } from './components/SettingsModal'
import type { AgentEvent, ApprovalDecision, ApprovalMode, ApprovalStatus, ProgressStep, SessionSummary } from './lib/agentProtocol'
import { agent, showScenarios } from './lib/agent'
import { EXAMPLE_PROMPTS } from './lib/examples'
import { notifyApproval } from './lib/notify'
import { addDetail, APPROVED_LABEL, AUTO_APPROVED_LABEL, BLOCKED_LABEL, finishActive, finishToolStep, hasActive, markTargetChanged, startStep, startToolStep, withSummary } from './lib/processSteps'
import { toChatMessages } from './lib/restore'
import type { ChatMessage, ChatSession, ProcessStep, StepState } from './types'

const PROGRESS_LABEL: Record<ProgressStep, { label: string; doneLabel: string }> = {
  loading_tools: { label: '도구 목록 불러오는 중', doneLabel: '도구 목록 불러옴' },
  understanding: { label: '요청 이해하는 중', doneLabel: '요청 이해함' },
}

// 다시 붙었을 때 이미 결정된 카드를 처리 과정 한 줄로 바꾼다(approval_resolved).
const RESOLVED_STEP: Record<Exclude<ApprovalStatus, 'pending'>, { state: Exclude<StepState, 'active'>; label: string }> = {
  approved: { state: 'done', label: APPROVED_LABEL },
  denied: { state: 'stopped', label: '거부함' },
  expired: { state: 'stopped', label: '승인 시간이 지나 취소됨' },
  cancelled: { state: 'stopped', label: '취소됨' },
}

const TITLE_MAX = 30
// 서버 대화 목록을 다시 받는 간격. 다른 탭이나 새로고침 전 화면이 돌린 작업이 끝났는지 본다.
const REFRESH_MS = 15_000

// Home의 "Go to Portainer" 버튼이 여는 주소. WEB 백엔드 설정(PORTAINER_URL)이 먼저이고, 목업처럼 백엔드가 없으면
// 빌드 값(VITE_PORTAINER_URL)을 쓴다. 둘 다 없으면 버튼을 비활성으로 둔다.
const BUILD_PORTAINER_URL: string | undefined = import.meta.env.VITE_PORTAINER_URL

// 좁은 화면에서는 사이드바가 채팅 위에 겹치므로, 대화를 고르면 닫는다. Tailwind md 기준과 같다.
const isNarrowScreen = () => !window.matchMedia('(min-width: 768px)').matches

// 마지막으로 보던 서버 대화. 다시 열면 그 대화를 연다(승인을 기다리던 대화를 사이드바에서 찾지 않게).
// 이 브라우저에만 저장한다. 저장소를 쓸 수 없으면(사생활 보호 모드 등) 새 대화로 시작한다.
const LAST_SESSION_KEY = 'bosun.lastSession'

function readLastSession(): string | null {
  try {
    return localStorage.getItem(LAST_SESSION_KEY)
  } catch {
    return null
  }
}

function writeLastSession(serverId: string) {
  try {
    localStorage.setItem(LAST_SESSION_KEY, serverId)
  } catch {
    // 저장하지 못해도 다음에 새 대화로 시작할 뿐이다.
  }
}

function newSession(): ChatSession {
  return { id: crypto.randomUUID(), title: '새 대화', messages: [] }
}

function titleFor(text: string) {
  const line = text.split('\n')[0].trim()
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line || '새 대화'
}

function App() {
  const [sessions, setSessions] = useState<ChatSession[]>(() => [newSession()])
  const [activeId, setActiveId] = useState(() => sessions[0].id)
  // 이 화면에서 처리 중인 대화(승인 대기 포함). 대화마다 따로 처리한다.
  const [localBusy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  // 서버 목록이 처리 중이라고 한 대화(서버 ID). 아직 열지 않은 대화에만 쓴다. 열면 다시 붙어서 이 화면이 맡는다.
  const [serverRunning, setServerRunning] = useState<ReadonlySet<string>>(() => new Set())
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  // 입력창에 넣을 글(도움말 예시를 누르면 채운다)
  const [draft, setDraft] = useState<{ text: string; key: number } | null>(null)
  // 정책 차단 안내의 "Portainer 열기" 링크. 못 받으면 링크 없이 문구만 보여준다.
  const [portainerUrl, setPortainerUrl] = useState<string>()
  // 승인 방식. 묻지 않는 방식이면 입력창 위에 늘 보여준다(모르고 켜 둔 채 쓰지 않게).
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('ask')
  useEffect(() => {
    agent.getSettings?.().then(
      (s) => {
        setPortainerUrl(s.portainerUrl)
        setApprovalMode(s.approvalMode)
      },
      () => undefined,
    )
  }, [])
  // 지금 이벤트를 받고 있는 대화
  const live = useRef(new Set<string>())
  const sessionsRef = useRef(sessions)
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  const busy = useMemo(() => {
    const ids = new Set(localBusy)
    for (const s of sessions) if (s.loaded === false && s.serverId && serverRunning.has(s.serverId)) ids.add(s.id)
    return ids
  }, [localBusy, serverRunning, sessions])

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0]
  const activeBusy = busy.has(active.id)

  // 다시 열었을 때 열 대화. 첫 서버 목록에서 찾으면 한 번만 쓴다.
  const reopen = useRef(readLastSession())
  useEffect(() => {
    if (active.serverId) writeLastSession(active.serverId)
  }, [active.serverId])

  const markBusy = useCallback((id: string, on: boolean) => {
    setBusy((prev) => {
      if (prev.has(id) === on) return prev
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  function patchSession(id: string, fn: (s: ChatSession) => ChatSession) {
    setSessions((prev) => prev.map((s) => (s.id === id ? fn(s) : s)))
  }

  // 서버 대화 목록을 사이드바에 합친다. 내용은 대화를 고를 때 불러온다. 목업에는 목록이 없다.
  const refreshList = useCallback(async () => {
    const listSessions = agent.listSessions
    if (!listSessions) return
    let list: SessionSummary[]
    try {
      list = await listSessions()
    } catch {
      // 목록을 못 불러와도 새 대화는 쓸 수 있다.
      return
    }
    const byServerId = new Map(list.map((s) => [s.sessionId, s]))
    setSessions((prev) => {
      const known = new Set(prev.map((s) => s.serverId))
      const updated = prev.map((s) => {
        const row = s.serverId ? byServerId.get(s.serverId) : undefined
        if (!row) return s
        return { ...s, title: row.title || s.title, pinned: row.pinned === true, inputTokens: row.inputTokens, outputTokens: row.outputTokens }
      })
      const restored = list
        .filter((s) => !known.has(s.sessionId))
        .map((s) => ({
          id: crypto.randomUUID(),
          serverId: s.sessionId,
          loaded: false,
          title: s.title || '제목 없음',
          messages: [],
          pinned: s.pinned === true,
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
        }))
      return [...updated, ...restored]
    })
    setServerRunning(new Set(list.filter((s) => s.running).map((s) => s.sessionId)))
  }, [])

  useEffect(() => {
    // 서버 대화 목록(외부 상태)과 맞추는 동기화다. 목록을 받은 뒤에 setState한다.
    // oxlint-disable-next-line react/set-state-in-effect
    void refreshList()
    const timer = setInterval(() => {
      if (!document.hidden) void refreshList()
    }, REFRESH_MS)
    const onFocus = () => void refreshList()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refreshList])

  useEffect(() => {
    const target = reopen.current
    if (!target) return
    const session = sessions.find((s) => s.serverId === target)
    if (!session) return
    reopen.current = null
    // 목록을 받기 전에 사용자가 이미 다른 대화를 시작했으면 그대로 둔다.
    if (active.messages.length > 0 || active.serverId) return
    // 서버 목록(외부 상태)에서 찾은 대화를 연다. 목록을 받은 뒤 한 번만 돈다.
    // oxlint-disable-next-line react/set-state-in-effect
    handleSelectSession(session.id)
    // 목록이 바뀔 때만 본다. 열고 나면 reopen을 비운다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions])

  // 메시지 id는 모든 대화에서 고유하므로, 처리 도중 다른 대화로 옮겨도 원래 메시지가 갱신된다.
  function updateMessage(id: string, fn: (m: ChatMessage) => Partial<ChatMessage>) {
    setSessions((prev) =>
      prev.map((s) =>
        s.messages.some((m) => m.id === id)
          ? { ...s, messages: s.messages.map((m) => (m.id === id ? { ...m, ...fn(m) } : m)) }
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
  async function consume(sessionId: string, id: string, events: AsyncIterable<AgentEvent>, initialContent = '') {
    let content = initialContent
    let awaitingApproval = false
    live.current.add(sessionId)

    try {
      for await (const event of events) {
        switch (event.type) {
          case 'progress':
            updateSteps(id, (steps) => startStep(steps, PROGRESS_LABEL[event.step]))
            break
          case 'text_delta':
            // 앞에 받은 내용이 없으면 맨 앞 줄바꿈은 버린다(복원된 카드를 승인한 뒤 등).
            content += content ? event.delta : event.delta.replace(/^\n+/, '')
            // 만료 뒤에 오는 Agent 설명은 만료 카드와 같이 보여준다.
            updateMessage(id, (m) => ({
              status: m.status === 'approval_expired' ? m.status : 'streaming',
              content,
            }))
            break
          case 'tool_status':
            updateSteps(id, (steps) => {
              const step = { label: event.summary, doneLabel: '도구 호출함', detail: event.tool }
              if (event.status === 'running') {
                return event.callId ? startToolStep(steps, step, event.callId) : startStep(steps, step)
              }
              const state = event.status === 'succeeded' ? 'done' : 'failed'
              const paired = event.callId && finishToolStep(steps, event.callId, state, event.summary)
              if (paired) return paired
              // 진행 중인 단계가 없었으면 결과를 새 줄로 남긴다.
              return hasActive(steps)
                ? finishActive(steps, state, event.summary)
                : [...steps, { id: crypto.randomUUID(), label: event.summary, detail: event.tool, state }]
            })
            break
          case 'approval_required': {
            awaitingApproval = true
            const title = sessionsRef.current.find((s) => s.id === sessionId)?.title
            notifyApproval(title ? `${title}: ${event.summary}` : event.summary)
            updateMessage(id, (m) => ({
              status: 'pending_approval',
              approval: {
                approvalId: event.approvalId,
                summary: event.summary,
                action: event.action,
                reasons: event.reasons,
                ...(event.risk ? { risk: event.risk } : {}),
                expiresAt: event.expiresAt,
              },
              steps: startStep(m.steps ?? [], { label: withSummary('사용자 승인 기다리는 중', event.summary) }),
            }))
            break
          }
          case 'auto_approved':
            // 승인 방식에 따라 WEB이 대신 승인했다. 카드 없이 처리 과정에 한 줄 남기고, 실행 줄은 tool_status로 이어 붙는다.
            updateSteps(id, (steps) => [
              ...finishActive(steps, 'done'),
              { id: crypto.randomUUID(), label: withSummary(AUTO_APPROVED_LABEL, event.summary), detail: event.tool, state: 'done' },
            ])
            break
          case 'approval_resolved': {
            // 다시 붙었을 때만 온다. 앞 카드는 이미 결정됐으니 처리 과정 한 줄로 남기고 이어서 받는다.
            awaitingApproval = false
            const { state, label } = RESOLVED_STEP[event.status]
            if (content) content += '\n'
            updateMessage(id, (m) => ({
              status: 'thinking',
              approval: undefined,
              steps: finishActive(m.steps ?? [], state, withSummary(label, m.approval?.summary)),
            }))
            break
          }
          case 'rejected':
            // 정책 차단이 아니라 WEB이 멈춘 것이다. 차단 안내 대신 처리 과정 한 줄과 답 아래 안내로 보여준다.
            if (event.code === 'TARGET_CHANGED') {
              updateMessage(id, (m) => ({ notice: event.reason, steps: markTargetChanged(m.steps ?? [], event.detail) }))
              break
            }
            // 막힌 뒤에도 Agent가 다른 작업을 이어 갈 수 있어서 상태는 바꾸지 않는다.
            updateMessage(id, (m) => ({
              rejectionReason: event.reason,
              rejectionDetails: addDetail(m.rejectionDetails, event.detail),
              policyBlocked: m.policyBlocked || event.code === 'POLICY_DENIED',
              // 진행 중이던 단계는 끝난 것으로 두고, 차단을 따로 한 줄 남긴다.
              steps: finishActive(startStep(m.steps ?? [], { label: withSummary(BLOCKED_LABEL, event.detail) }), 'failed'),
            }))
            break
          case 'error':
            if (event.code === 'STOPPED') {
              updateMessage(id, (m) => stoppedPatch(m))
              break
            }
            updateMessage(id, (m) => ({
              // 만료 거부가 늦어 이미 처리된 경우(409)에는 만료 카드를 그대로 둔다.
              status: m.status === 'approval_expired' ? m.status : 'error',
              errorMessage: event.message,
              steps: finishActive(m.steps ?? [], 'failed'),
            }))
            break
          case 'done':
            updateMessage(id, (m) => ({
              status: m.status === 'streaming' || m.status === 'thinking' ? 'done' : m.status,
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

    live.current.delete(sessionId)
    if (!awaitingApproval) markBusy(sessionId, false)
  }

  function stoppedPatch(m: ChatMessage): Partial<ChatMessage> {
    return {
      status: 'done',
      approval: undefined,
      notice: '작업을 멈췄어요.',
      steps: [...finishActive(m.steps ?? [], 'stopped'), { id: crypto.randomUUID(), label: '사용자가 멈춤', state: 'stopped' }],
    }
  }

  async function sendIn(session: ChatSession, text: string) {
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text, status: 'done' }
    const assistantId = crypto.randomUUID()
    const assistantPlaceholder: ChatMessage = { id: assistantId, role: 'assistant', content: '', status: 'thinking' }

    patchSession(session.id, (s) => ({
      ...s,
      // 첫 메시지로 대화 제목을 정한다. 복제한 대화처럼 제목이 이미 있으면 그대로 둔다.
      title: s.messages.length === 0 && s.title === '새 대화' ? titleFor(text) : s.title,
      messages: [...s.messages, userMessage, assistantPlaceholder],
    }))
    markBusy(session.id, true)

    let serverId: string
    try {
      serverId = await getServerId(session)
    } catch {
      updateMessage(assistantId, () => ({
        status: 'error',
        errorMessage: '대화를 시작하지 못했어요. 잠시 후 다시 시도해주세요.',
      }))
      markBusy(session.id, false)
      return
    }
    await consume(session.id, assistantId, agent.sendMessage(serverId, text))
  }

  function handleSend(text: string) {
    void sendIn(active, text)
  }

  // 처리 중인 턴에 다시 붙는다(새로고침 뒤, 다른 탭에서 돌린 작업). 이 턴의 이벤트를 처음부터 받는다.
  function attachTo(sessionId: string, serverId: string) {
    const attach = agent.attach
    if (!attach) return
    const id = crypto.randomUUID()
    patchSession(sessionId, (s) => ({
      ...s,
      messages: [...s.messages, { id, role: 'assistant', content: '', status: 'thinking' }],
    }))
    markBusy(sessionId, true)
    void consume(sessionId, id, attach(serverId))
  }

  async function handleStop() {
    const session = active
    if (!session.serverId || !agent.stop) return
    try {
      await agent.stop(session.serverId)
    } catch {
      window.alert('멈추지 못했어요. 잠시 후 다시 시도해주세요.')
      return
    }
    // 승인 대기 중이면 열린 스트림이 없으니 화면에서 직접 바꾼다. 받고 있는 스트림은 STOPPED로 끝난다.
    if (!live.current.has(session.id)) {
      const pending = session.messages.findLast((m) => m.status === 'pending_approval')
      if (pending) updateMessage(pending.id, (m) => stoppedPatch(m))
      markBusy(session.id, false)
    }
  }

  // 승인 대기 시간이 지나면 카드를 만료로 바꾸고, 서버에 만료 거부를 보내 Agent의 이어지는 말을 받는다.
  // 입력 잠금은 그 스트림이 끝날 때 푼다.
  async function handleExpire(id: string) {
    const session = sessions.find((s) => s.messages.some((m) => m.id === id))
    const message = session?.messages.find((m) => m.id === id)
    updateMessage(id, (m) =>
      m.status === 'pending_approval'
        ? { status: 'approval_expired', steps: finishActive(m.steps ?? [], 'stopped', withSummary('승인 시간이 지나 취소됨', m.approval?.summary)) }
        : {},
    )
    if (!session) return
    if (!session.serverId || !message?.approval) {
      markBusy(session.id, false)
      return
    }
    await consume(
      session.id,
      id,
      agent.sendDecision(session.serverId, message.approval.approvalId, 'deny', 'expired'),
      message.content ? `${message.content}\n` : '',
    )
  }

  async function handleDecision(id: string, decision: ApprovalDecision) {
    const session = sessions.find((s) => s.messages.some((m) => m.id === id))
    const message = session?.messages.find((m) => m.id === id)
    if (!session?.serverId || !message?.approval) return

    const { approvalId, summary } = message.approval
    const initialContent = message.content ? `${message.content}\n` : ''
    updateMessage(id, (m) => {
      const steps = m.steps ?? []
      return {
        status: 'thinking',
        approval: undefined,
        steps:
          // 승인 뒤 도구 실행 줄은 Agent가 보내는 tool_status로 붙는다.
          decision === 'approve'
            ? finishActive(steps, 'done', withSummary(APPROVED_LABEL, summary))
            : finishActive(steps, 'stopped', withSummary('거부함', summary)),
      }
    })

    await consume(session.id, id, agent.sendDecision(session.serverId, approvalId, decision), initialContent)
  }

  // 사용자 메시지를 고쳐 다시 보낸다. 그 메시지 직전까지 복사한 새 대화를 만들어 거기서 보낸다(원래 대화는 그대로).
  async function handleEdit(messageId: string, text: string) {
    const session = sessions.find((s) => s.messages.some((m) => m.id === messageId))
    if (!session || busy.has(session.id)) return
    const index = session.messages.findIndex((m) => m.id === messageId)
    const turn = session.messages.slice(0, index).filter((m) => m.role === 'user').length
    let fork: ChatSession = { ...newSession(), title: `${session.title} (수정)`, messages: session.messages.slice(0, index) }
    if (session.serverId && agent.forkSession) {
      try {
        const forked = await agent.forkSession(session.serverId, turn)
        fork = { ...fork, serverId: forked.sessionId, title: forked.title || fork.title, loaded: true }
        // 첫 메시지를 고치면 남는 내용이 없으니 새 대화와 같다. 제목도 고친 메시지로 정한다.
        if (turn === 0) {
          fork.title = titleFor(text)
          await agent.renameSession?.(forked.sessionId, fork.title).catch(() => undefined)
        }
      } catch {
        window.alert('대화를 복제하지 못했어요. 잠시 후 다시 시도해주세요.')
        return
      }
    }
    setSessions((prev) => [fork, ...prev])
    setActiveId(fork.id)
    await sendIn(fork, text)
  }

  // 오류가 난 답의 바로 앞 사용자 메시지를 같은 대화에서 다시 보낸다.
  function handleRetry(messageId: string) {
    const session = sessions.find((s) => s.messages.some((m) => m.id === messageId))
    if (!session || busy.has(session.id)) return
    const index = session.messages.findIndex((m) => m.id === messageId)
    const prompt = session.messages.slice(0, index).findLast((m) => m.role === 'user')
    if (prompt) void sendIn(session, prompt.content)
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

  async function handleDeleteSession(id: string) {
    const session = sessions.find((s) => s.id === id)
    if (!session || busy.has(id)) return
    if (!window.confirm(`'${session.title}' 대화를 삭제할까요? 되돌릴 수 없어요.`)) return
    if (session.serverId && agent.deleteSession) {
      try {
        await agent.deleteSession(session.serverId)
      } catch {
        window.alert('대화를 삭제하지 못했어요. 잠시 후 다시 시도해주세요.')
        return
      }
    }
    // 마지막 대화를 지우면 빈 새 대화를 하나 둔다. 보고 있던 대화를 지우면 맨 위 대화로 간다.
    const rest = sessions.filter((s) => s.id !== id)
    const next = rest.length > 0 ? rest : [newSession()]
    setSessions(next)
    if (id === activeId) setActiveId(next[0].id)
  }

  // 사이드바에서 고른 대화를 한꺼번에 지운다. 처리 중인 대화는 서버가 지우지 않으므로 뺀다.
  async function handleDeleteMany(ids: string[]) {
    const targets = sessions.filter((s) => ids.includes(s.id) && !busy.has(s.id))
    if (targets.length === 0) return
    if (!window.confirm(`대화 ${targets.length}개를 삭제할까요? 되돌릴 수 없어요.`)) return
    const deleted = new Set<string>()
    for (const s of targets) {
      if (s.serverId && agent.deleteSession) {
        try {
          await agent.deleteSession(s.serverId)
        } catch {
          continue
        }
      }
      deleted.add(s.id)
    }
    // 지우는 사이 목록이 바뀌었을 수 있어서 최신 목록에서 뺀다.
    const rest = sessionsRef.current.filter((s) => !deleted.has(s.id))
    const next = rest.length > 0 ? rest : [newSession()]
    setSessions(next)
    setActiveId((prev) => (deleted.has(prev) ? next[0].id : prev))
    if (deleted.size < targets.length) {
      window.alert(`${targets.length - deleted.size}개는 삭제하지 못했어요. 잠시 후 다시 시도해주세요.`)
    }
  }

  async function handleRename(id: string, title: string) {
    const session = sessions.find((s) => s.id === id)
    const trimmed = title.replace(/\s+/g, ' ').trim().slice(0, 100)
    if (!session || !trimmed || trimmed === session.title) return
    patchSession(id, (s) => ({ ...s, title: trimmed }))
    if (!session.serverId || !agent.renameSession) return
    try {
      await agent.renameSession(session.serverId, trimmed)
    } catch {
      patchSession(id, (s) => ({ ...s, title: session.title }))
      window.alert('제목을 바꾸지 못했어요. 잠시 후 다시 시도해주세요.')
    }
  }

  async function handlePin(id: string, pinned: boolean) {
    const session = sessions.find((s) => s.id === id)
    if (!session) return
    patchSession(id, (s) => ({ ...s, pinned }))
    if (!session.serverId || !agent.pinSession) return
    try {
      await agent.pinSession(session.serverId, pinned)
    } catch {
      patchSession(id, (s) => ({ ...s, pinned: !pinned }))
    }
  }

  function handleSelectSession(id: string) {
    setActiveId(id)
    if (isNarrowScreen()) setSidebarOpen(false)

    const session = sessions.find((s) => s.id === id)
    const loadMessages = agent.loadMessages
    if (!session?.serverId || session.loaded !== false || !loadMessages) return
    const serverId = session.serverId
    patchSession(id, (s) => ({ ...s, loaded: true }))
    loadMessages(serverId)
      .then(({ messages: restored, running }) => {
        const messages = toChatMessages(restored)
        patchSession(id, (s) => ({ ...s, messages }))
        if (running) {
          attachTo(id, serverId)
          return
        }
        // 결정하지 않은 승인 카드가 있으면 그 대화가 처리 중이다.
        markBusy(id, messages.some((m) => m.status === 'pending_approval'))
      })
      .catch(() => {
        patchSession(id, (s) => ({ ...s, loaded: false }))
      })
  }

  function pickExample(text: string) {
    setHelpOpen(false)
    setDraft((prev) => ({ text, key: (prev?.key ?? 0) + 1 }))
  }

  const isEmpty = active.messages.length === 0
  const canStop = activeBusy && Boolean(active.serverId && agent.stop)

  const composer = (
    <div className="w-full max-w-2xl px-4">
      {approvalMode !== 'ask' && (
        <p className="pb-2 text-center text-xs">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className={`rounded-full px-2.5 py-0.5 font-medium ${
              approvalMode === 'never' ? 'bg-red-50 text-red-700 hover:bg-red-100' : 'bg-amber-50 text-amber-800 hover:bg-amber-100'
            }`}
          >
            {approvalMode === 'never' ? '묻지 않기(YOLO) 켜짐: 삭제도 승인 없이 실행돼요' : '위험한 작업만 물어요: 나머지는 승인 없이 실행돼요'}
          </button>
        </p>
      )}
      {activeBusy && (
        <p className="pb-2 text-center text-xs text-neutral-500">
          이 대화에서 작업을 처리하고 있어요. 다른 대화는 그대로 쓸 수 있어요.
        </p>
      )}
      <ChatInput
        key={draft?.key ?? 0}
        disabled={activeBusy}
        initialText={draft?.text}
        onSend={(text) => {
          // 예시로 채운 글은 한 번만 쓴다. 입력창이 다시 그려질 때 또 채우지 않게 비운다.
          setDraft(null)
          handleSend(text)
        }}
        onStop={canStop ? handleStop : undefined}
        onHelp={() => setHelpOpen(true)}
      />
      {/* Home에서는 와이어프레임대로 입력창 바로 아래에 Portainer 버튼을 둔다. */}
      {!isEmpty && (
        <p className="py-2 text-center text-xs text-neutral-400">AI는 실수할 수 있어요. 승인 카드의 내용을 꼭 확인해주세요.</p>
      )}
    </div>
  )

  return (
    <div className="flex h-dvh bg-white text-neutral-900">
      {sidebarOpen && (
        <SessionSidebar
          sessions={sessions}
          activeId={active.id}
          busy={busy}
          exportUrl={agent.exportUrl}
          onClose={() => setSidebarOpen(false)}
          onSelect={handleSelectSession}
          onNew={handleNewSession}
          onDelete={handleDeleteSession}
          onDeleteMany={handleDeleteMany}
          onRename={handleRename}
          onPin={agent.pinSession || !agent.listSessions ? handlePin : undefined}
        />
      )}

      <main className="relative flex min-w-0 flex-1 flex-col">
        {!sidebarOpen && (
          <div className="absolute top-3 left-3 z-10">
            <SidebarToggle label="대화 목록 열기" onClick={() => setSidebarOpen(true)} />
          </div>
        )}
        <AgentStatusBanner />

        {isEmpty ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto py-12">
            {/* 로고 이미지를 받으면 이 자리를 <img>로 바꾼다. */}
            <div className="flex h-36 w-56 items-end justify-center rounded-md border border-dashed border-neutral-300 pb-3 text-4xl font-black tracking-tight">
              BOSUN
            </div>
            {composer}
            <div className="flex max-w-2xl flex-wrap justify-center gap-1.5 px-4">
              {EXAMPLE_PROMPTS.slice(0, 4).map((p) => (
                <button
                  key={p.text}
                  type="button"
                  onClick={() => pickExample(p.text)}
                  className="rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
                >
                  {p.text}
                </button>
              ))}
            </div>
            {portainerUrl || BUILD_PORTAINER_URL ? (
              <a
                href={portainerUrl || BUILD_PORTAINER_URL}
                target="_blank"
                rel="noreferrer"
                className="rounded-full bg-neutral-100 px-8 py-1 text-xs text-neutral-600 hover:bg-neutral-200"
              >
                Go to Portainer
              </a>
            ) : (
              <span
                title="WEB 백엔드에 PORTAINER_URL을 정하면 열려요"
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
              busy={activeBusy}
              portainerUrl={portainerUrl}
              onApprove={(id) => handleDecision(id, 'approve')}
              onDeny={(id) => handleDecision(id, 'deny')}
              onExpire={handleExpire}
              onEdit={handleEdit}
              onRetry={handleRetry}
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
            showScenarios ? 'lg:bottom-14' : 'lg:bottom-3'
          }`}
        >
          <GearIcon />
        </button>

        {showScenarios && <DevScenarioBar disabled={activeBusy} onRun={handleSend} />}
      </main>

      {settingsOpen && (
        <SettingsModal
          activeServerId={active.serverId}
          onClose={() => setSettingsOpen(false)}
          onApprovalModeChange={setApprovalMode}
          onDraft={(text) => {
            // 백업 복원 요청은 새 대화에서 쓴다. 지금 대화가 처리 중이어도 보낼 수 있게.
            setSettingsOpen(false)
            handleNewSession()
            pickExample(text)
          }}
        />
      )}
      {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} onPick={pickExample} />}
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
