// 한 턴(메시지 하나에 대한 Agent 처리)과 그 안의 승인 요청을 관리한다. 계약 6장 흐름을 코드로 옮긴 것이다.
//
// - 턴은 대화마다 하나다. 대화가 다르면 동시에 돌 수 있다(계약 3장). Docker Agent도 세션마다 런타임이 따로 있어서
//   /resume과 승인 대기가 세션 단위다. 동시에 도는 턴 수는 MAX_TURNS로 막는다.
// - 승인 요청은 Agent 스트림의 tool_call_confirmation으로 온다. 결정은 Docker Agent /resume으로 보낸다.
//   Docker Agent는 한 세션에서 승인을 한 번에 하나만 기다리고 resume에는 도구 호출 ID가 없다. 그래서 카드도 대화마다 한 장이다.
// - 승인 카드를 보내면 브라우저 쪽 응답만 끝내고 Agent 스트림은 열어 둔다. 승인·거부 POST가 오면
//   그 응답으로 나머지를 이어서 보낸다. 그 사이에 온 이벤트는 모아 뒀다가 보낸다.
// - 턴에서 브라우저로 보낸 이벤트는 log에도 모아 둔다. 새로고침한 화면이 GET .../stream으로 다시 붙으면 처음부터 다시 보낸다.

import { randomUUID } from 'node:crypto'
import type { AgentEvent, ApprovalDecision } from '../src/lib/agentProtocol.ts'
import * as agent from './agentClient.ts'
import type { DAEvent } from './agentClient.ts'
import { config } from './config.ts'
import { currentModel } from './settings.ts'
import { addCard, logDecision, updateApprovalCard, type ApprovalStatus } from './store.ts'
import { approvalCard, learnNames } from './tools.ts'
import { Translator } from './translate.ts'

export interface Sink {
  send(event: AgentEvent): void
  end(): void
}

type ApprovalEvent = Extract<AgentEvent, { type: 'approval_required' }>

interface Approval {
  id: string
  sessionId: string
  tool: string
  toolCallId: string
  status: ApprovalStatus
  // Agent에 결정을 보내는 중. 그 사이 만료 타이머나 두 번째 결정이 또 보내지 않게 막는다.
  sending: boolean
  timer?: NodeJS.Timeout
  event: ApprovalEvent
}

interface Turn {
  sessionId: string
  // 이 세션에서 몇 번째 사용자 메시지인지(0부터). 카드를 대화 복원 위치에 붙일 때 쓴다.
  index: number
  abort: AbortController
  sink: Sink | null
  buffer: AgentEvent[]
  // 이 턴에서 브라우저로 보낸 이벤트 전부(다시 붙기용). 이어지는 text_delta는 하나로 합친다.
  log: AgentEvent[]
  // 실행 중인 도구 호출 ID → 이름·인자. 결과가 오면 names를 채운다. 브라우저로는 보내지 않는다.
  calls: Map<string, { name: string; args: Record<string, unknown> }>
  // 결정을 기다리는 카드. 브라우저 스트림이 열려 있으면 바로 보내고, 아니면 다음에 붙을 때 보낸다.
  waiting: Approval | null
  // waiting을 브라우저에 보냈는지
  shown: boolean
  finished: boolean
}

// 세션 ID → 진행 중인 턴
const turns = new Map<string, Turn>()
// 대화 제목 길이. 화면(App.tsx)과 같다.
const TITLE_MAX = 30
// 다시 붙기용 log 상한. text_delta는 합쳐지므로 보통 넘지 않는다. 넘으면 더 쌓지 않는다.
const MAX_LOG = 5000
const approvals = new Map<string, Approval>()
// 조회 결과로 알아 둔 컨테이너·이미지 ID(앞 12자리) → 이름. 승인 카드에 이름을 보여줄 때 쓴다.
const names = new Map<string, string>()

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

// 이 대화를 처리하고 있는지(승인 대기 포함)
export function isRunning(sessionId: string): boolean {
  return turns.has(sessionId)
}

export function runningCount(): number {
  return turns.size
}

// 처리 중인 턴이 몇 번째 사용자 메시지인지. 대화 복원은 그 턴의 답을 빼고 보낸다(화면이 다시 붙어서 받는다).
export function runningIndex(sessionId: string): number | undefined {
  return turns.get(sessionId)?.index
}

// ---- 브라우저 쪽 출력 ----

function record(t: Turn, event: AgentEvent): void {
  const prev = t.log.at(-1)
  if (event.type === 'text_delta' && prev?.type === 'text_delta') {
    t.log[t.log.length - 1] = { type: 'text_delta', delta: prev.delta + event.delta }
    return
  }
  if (t.log.length < MAX_LOG) t.log.push(event)
}

function emit(t: Turn, event: AgentEvent): void {
  record(t, event)
  if (t.sink) t.sink.send(event)
  else t.buffer.push(event)
  if (event.type === 'rejected') addCard(t.sessionId, t.index, { kind: 'rejected', code: event.code, reason: event.reason })
  if (event.type === 'done' || event.type === 'error') finish(t)
}

function attach(t: Turn, sink: Sink): void {
  t.sink = sink
  const pending = t.buffer
  t.buffer = []
  // 모아 둔 이벤트는 emit에서 이미 기록했으므로 보내기만 한다.
  let ended = false
  for (const event of pending) {
    sink.send(event)
    if (event.type === 'done' || event.type === 'error') {
      ended = true
      break
    }
  }
  // 응답을 여는 사이에 턴이 이미 끝났을 수 있다. 그때는 finish가 이 sink를 모르므로 직접 닫는다.
  if (ended || t.finished) {
    finish(t)
    sink.end()
    return
  }
  show(t)
}

export function detach(sink: Sink): void {
  for (const t of turns.values()) if (t.sink === sink) t.sink = null
}

// 새로고침한 화면이 진행 중인 턴에 다시 붙는다. 이 턴에서 보낸 이벤트를 처음부터 다시 보내고 이어서 보낸다.
// 다른 화면이 붙어 있으면 그 응답은 끝낸다(한 턴에 브라우저 스트림은 하나).
export function reattach(sessionId: string): (sink: Sink) => void {
  const t = turns.get(sessionId)
  if (!t) throw new HttpError(404, 'NOT_RUNNING', '처리 중인 작업이 없어요.')
  return (sink) => {
    const old = t.sink
    t.sink = null
    old?.end()
    t.buffer = []
    for (const event of t.log) sink.send(event)
    if (t.finished) {
      sink.end()
      return
    }
    // 결정을 기다리는 카드가 있으면 log 끝에 그 카드가 있다. 브라우저 스트림은 거기서 끝난다(계약 4장).
    if (t.waiting?.status === 'pending') {
      t.shown = true
      sink.end()
      return
    }
    t.sink = sink
  }
}

// 사용자가 처리를 멈춘다. Agent 스트림을 끊으면 Docker Agent도 실행을 취소하고 기다리던 승인도 취소된다(계약 6장).
export function stopTurn(sessionId: string): void {
  const t = turns.get(sessionId)
  if (!t) throw new HttpError(404, 'NOT_RUNNING', '처리 중인 작업이 없어요.')
  emit(t, { type: 'error', code: 'STOPPED', message: '작업을 멈췄어요.' })
}

function show(t: Turn): void {
  if (!t.waiting || t.shown || !t.sink || t.finished) return
  t.shown = true
  t.sink.send(t.waiting.event)
  // 브라우저 쪽 스트림은 approval_required로 끝난다(계약 4장). Agent 스트림은 계속 열어 둔다.
  const sink = t.sink
  t.sink = null
  sink.end()
}

function finish(t: Turn): void {
  if (t.finished) return
  t.finished = true
  // Agent 스트림을 끊으면 Docker Agent도 기다리던 승인을 취소한다. 카드도 취소로 둔다(계약 6장).
  if (t.waiting?.status === 'pending') resolve(t.waiting, 'cancelled')
  t.calls.clear()
  t.sink?.end()
  t.sink = null
  t.abort.abort()
  if (turns.get(t.sessionId) === t) turns.delete(t.sessionId)
}

// ---- 턴 시작 ----

export async function startTurn(sessionId: string, text: string): Promise<(sink: Sink) => void> {
  if (turns.has(sessionId)) throw new HttpError(409, 'BUSY', '이 대화에서 처리 중인 작업이 있어요. 끝나면 다시 보내주세요.')
  if (turns.size >= config.maxTurns) {
    throw new HttpError(409, 'TOO_MANY', `동시에 처리할 수 있는 대화는 ${config.maxTurns}개예요. 다른 대화가 끝나면 다시 보내주세요.`)
  }
  const t: Turn = {
    sessionId,
    index: 0,
    abort: new AbortController(),
    sink: null,
    buffer: [],
    log: [],
    calls: new Map(),
    waiting: null,
    shown: false,
    finished: false,
  }
  // 기다리는 동안 같은 대화에 다른 요청이 끼어들지 않게 먼저 자리를 잡는다.
  turns.set(sessionId, t)

  let upstream: AsyncGenerator<DAEvent>
  try {
    const session = await agent.getSession(sessionId)
    t.index = (session.messages ?? []).filter((m) => m.message?.role === 'user' && !m.implicit).length
    // 첫 메시지로 제목을 정한다. 화면과 같은 규칙이다. Docker Agent가 따로 만들면 LLM을 한 번 더 부르고,
    // 영어 프롬프트라서 영어 제목이나 빈 제목이 나왔다(2026-10-11 실측).
    if (t.index === 0 && !session.title) {
      const title = text.trim().length > TITLE_MAX ? `${text.trim().slice(0, TITLE_MAX)}…` : text.trim()
      await agent.setTitle(sessionId, title).catch((err) => console.warn('[agent] set title failed', err))
    }
    upstream = await agent.runAgent(sessionId, text, t.abort.signal, currentModel())
  } catch (err) {
    turns.delete(sessionId)
    if (err instanceof agent.AgentHttpError && err.status === 404) {
      throw new HttpError(404, 'NO_SESSION', '대화를 찾을 수 없어요.')
    }
    if (err instanceof agent.AgentHttpError && err.status === 409) {
      throw new HttpError(409, 'BUSY', 'AI Agent가 이 대화를 처리하고 있어요. 잠시 후 다시 보내주세요.')
    }
    console.error('[agent] start failed', err)
    // Docker Agent는 모델 API 키가 없으면 실행 요청을 500으로 거절한다.
    if (err instanceof agent.AgentHttpError && err.message.includes('environment variables must be set')) {
      throw new HttpError(502, 'NO_API_KEY', 'AI 모델 API 키가 설정되지 않았어요. 관리자에게 알려주세요.')
    }
    throw new HttpError(502, 'AGENT_UNAVAILABLE', 'AI Agent에 연결하지 못했어요.')
  }

  void pump(t, upstream)
  return (sink) => attach(t, sink)
}

async function pump(t: Turn, upstream: AsyncGenerator<DAEvent>): Promise<void> {
  const translator = new Translator()
  try {
    for await (const ev of upstream) {
      if (t.finished) break
      track(t, ev)
      if (ev.type === 'tool_call_confirmation') {
        ask(t, ev as Extract<DAEvent, { type: 'tool_call_confirmation' }>)
        continue
      }
      if (ev.type === 'max_iterations_reached') {
        // agent.yaml의 max_iterations에 닿으면 Docker Agent가 계속할지 묻고 기다린다. WEB에는 그 화면이 없으므로 멈춘다.
        agent.resume(t.sessionId, 'reject').catch((err) => console.error('[agent] resume failed', err))
        continue
      }
      const { events, abort } = translator.translate(ev)
      for (const event of events) {
        emit(t, event)
        if (t.finished) break
      }
      if (abort) finish(t)
    }
  } catch (err) {
    if (!t.finished) console.error('[agent] stream failed', err)
  }
  // stream_stopped 없이 끊기면 오류로 끝낸다.
  if (!t.finished) {
    emit(t, { type: 'error', code: 'AGENT_DISCONNECTED', message: 'AI Agent와 연결이 끊겼어요. 잠시 후 다시 시도해주세요.' })
  }
}

// Docker Agent는 승인을 받은 뒤에 tool_call을 보낸다. 거부·차단된 호출에는 tool_call 없이 tool_call_response만 온다.
function track(t: Turn, ev: DAEvent): void {
  if (ev.type === 'tool_call') {
    const call = (ev as Extract<DAEvent, { type: 'tool_call' }>).tool_call
    if (call.id) t.calls.set(call.id, { name: call.function.name ?? '', args: parseArgs(call.function.arguments) })
    return
  }
  if (ev.type !== 'tool_call_response') return
  const res = ev as Extract<DAEvent, { type: 'tool_call_response' }>
  // 결정 전에 그 호출이 끝났으면(Agent 쪽 취소 등) 카드를 취소로 둔다.
  if (t.waiting?.status === 'pending' && t.waiting.toolCallId === res.tool_call_id) resolve(t.waiting, 'cancelled')
  const call = t.calls.get(res.tool_call_id)
  t.calls.delete(res.tool_call_id)
  if (call && !res.result?.isError) learnNames(names, call.name, call.args, res.response)
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

// ---- 승인 요청 ----

// Agent(LLM)가 거부 사유로 받는 문장. 사용자가 거부할 때는 사유를 붙이지 않는다.
const EXPIRED_REASON = 'The approval request expired without a decision.'

function ask(t: Turn, ev: Extract<DAEvent, { type: 'tool_call_confirmation' }>): void {
  const call = ev.tool_call
  const tool = call.function.name ?? ev.tool_definition?.name ?? ''
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(call.function.arguments || '{}')
  } catch {
    // 인자를 못 읽으면 공통 문구 카드를 띄운다.
  }
  // Docker Agent는 결정을 받기 전에는 다음 승인을 보내지 않는다. 그래도 오면 앞 카드는 더 쓸 수 없다.
  if (t.waiting?.status === 'pending') resolve(t.waiting, 'cancelled')

  const expiresAt = Date.now() + config.approvalTimeoutMs
  const card = approvalCard(tool, args, names)
  const ap: Approval = {
    id: `ap_${randomUUID()}`,
    sessionId: t.sessionId,
    tool,
    toolCallId: call.id ?? '',
    status: 'pending',
    sending: false,
    event: { type: 'approval_required', approvalId: '', ...card, expiresAt: new Date(expiresAt).toISOString() },
  }
  ap.event.approvalId = ap.id
  approvals.set(ap.id, ap)
  ap.timer = setTimeout(() => void expire(ap), config.approvalTimeoutMs + config.expiryGraceMs)
  addCard(t.sessionId, t.index, { kind: 'approval', approvalId: ap.id, status: 'pending', ...card, expiresAt: ap.event.expiresAt })

  t.waiting = ap
  t.shown = false
  record(t, ap.event)
  show(t)
}

function resolve(ap: Approval, status: ApprovalStatus): void {
  ap.status = status
  clearTimeout(ap.timer)
  updateApprovalCard(ap.id, status)
  const t = turns.get(ap.sessionId)
  if (t?.waiting === ap) {
    t.waiting = null
    t.shown = false
    // 다시 붙은 화면이 이 카드를 결정된 것으로 보이게 한다. 지금 붙어 있는 화면은 이미 알고 있으므로 log에만 넣는다.
    if (status !== 'pending') record(t, { type: 'approval_resolved', approvalId: ap.id, status })
  }
}

// 사용자가 없어도 만료되면 거부한다. 이어지는 Agent 출력은 받을 곳이 없으면 모아 둔다(대화 기록에는 남는다).
async function expire(ap: Approval): Promise<void> {
  if (ap.status !== 'pending' || ap.sending) return
  ap.sending = true
  try {
    await agent.resume(ap.sessionId, 'reject', EXPIRED_REASON)
  } catch (err) {
    // 보내지 못해도 카드는 만료로 둔다. 턴이 끝나면 Agent 스트림을 끊어 정리된다.
    console.error('[agent] expiry reject failed', err)
  }
  ap.sending = false
  if (ap.status !== 'pending') return
  resolve(ap, 'expired')
  logDecision({ user: 'system', sessionId: ap.sessionId, approvalId: ap.id, toolCallId: ap.toolCallId, tool: ap.tool, decision: 'expired' })
}

// ---- 사용자 결정 ----

export async function decide(
  sessionId: string,
  approvalId: string,
  decision: ApprovalDecision,
  user: string,
  reason?: string,
): Promise<(sink: Sink) => void> {
  const ap = approvals.get(approvalId)
  if (!ap || ap.sessionId !== sessionId) throw new HttpError(404, 'NO_APPROVAL', '승인 요청을 찾을 수 없어요.')
  const t = turns.get(sessionId)

  // 서버가 먼저 만료 처리한 뒤 브라우저의 만료 거부가 온 경우: 이어지는 응답만 붙여 준다.
  if (ap.status === 'expired' && decision === 'deny' && reason === 'expired' && t) {
    return (sink) => attach(t, sink)
  }
  if (ap.status !== 'pending' || ap.sending || !t || t.waiting !== ap) {
    throw new HttpError(409, 'APPROVAL_CLOSED', '이미 처리됐거나 만료된 승인이에요.')
  }

  ap.sending = true
  try {
    if (decision === 'approve') await agent.resume(sessionId, 'approve')
    else await agent.resume(sessionId, 'reject', reason === 'expired' ? EXPIRED_REASON : undefined)
  } catch (err) {
    ap.sending = false
    // 턴이 이미 끝났으면 Docker Agent가 실행 중이 아니라고 거절한다.
    if (err instanceof agent.AgentHttpError && (err.status === 404 || /not (running|found)/.test(err.message))) {
      if (ap.status === 'pending') resolve(ap, 'cancelled')
      throw new HttpError(409, 'APPROVAL_CLOSED', '이미 처리됐거나 만료된 승인이에요.')
    }
    console.error('[agent] decision failed', err)
    throw new HttpError(502, 'AGENT_UNAVAILABLE', 'AI Agent에 연결하지 못했어요. 다시 눌러주세요.')
  }
  ap.sending = false

  const status: ApprovalStatus =
    decision === 'approve' ? 'approved' : reason === 'expired' ? 'expired' : 'denied'
  // 보내는 사이 턴이 끝나 취소됐으면 그 상태를 둔다.
  if (ap.status === 'pending') resolve(ap, status)
  logDecision({ user, sessionId, approvalId, toolCallId: ap.toolCallId, tool: ap.tool, decision: status })
  return (sink) => attach(t, sink)
}
