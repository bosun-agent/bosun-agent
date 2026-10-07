// 한 턴(메시지 하나에 대한 Agent 처리)과 그 안의 승인 요청을 관리한다. 계약 6장 흐름을 코드로 옮긴 것이다.
//
// - WEB 백엔드 전체에서 Agent 스트림은 한 번에 하나만 연다(계약 3장). 그래서 상태도 하나다.
// - 승인 요청은 Airlock webhook으로 와서 지금 도구를 실행 중인 턴에 붙는다(계약 7장).
// - 승인 카드를 보내면 브라우저 쪽 응답만 끝내고 Agent 스트림은 열어 둔다. 승인·거부 POST가 오면
//   그 응답으로 나머지를 이어서 보낸다. 그 사이에 온 이벤트는 모아 뒀다가 보낸다.

import { randomUUID } from 'node:crypto'
import type { AgentEvent, ApprovalDecision } from '../src/lib/agentProtocol.ts'
import * as agent from './agentClient.ts'
import type { DAEvent } from './agentClient.ts'
import * as airlock from './airlockClient.ts'
import type { AirlockRequest } from './airlockClient.ts'
import { config } from './config.ts'
import { currentModel } from './settings.ts'
import { addCard, logDecision, updateApprovalCard, type ApprovalStatus } from './store.ts'
import { approvalCard, execCommand } from './tools.ts'
import { Translator } from './translate.ts'

export interface Sink {
  send(event: AgentEvent): void
  end(): void
}

type ApprovalEvent = Extract<AgentEvent, { type: 'approval_required' }>

interface Approval {
  id: string
  airlockId: string
  sessionId: string
  tool: string
  toolCallId: string
  status: ApprovalStatus
  timer?: NodeJS.Timeout
  event: ApprovalEvent
}

interface RunningCall {
  name: string
  args: Record<string, unknown>
  approvalId?: string
}

interface Turn {
  sessionId: string
  // 이 세션에서 몇 번째 사용자 메시지인지(0부터). 카드를 대화 복원 위치에 붙일 때 쓴다.
  index: number
  abort: AbortController
  running: Map<string, RunningCall>
  sink: Sink | null
  buffer: AgentEvent[]
  // 브라우저에 띄운 카드. 결정이 오기 전까지 다음 카드는 queue에서 기다린다(계약 6장, 한 번에 한 장).
  shown: Approval | null
  queue: Approval[]
  finished: boolean
}

const AIRLOCK_DEFAULT_TIMEOUT_MS = 300_000

let turn: Turn | null = null
const approvals = new Map<string, Approval>()
const seenAirlockIds = new Set<string>()
// exec 생성 결과로 받은 exec ID → 명령(계약 7장 exec 승인 카드 두 번 문제)
const execCommands = new Map<string, string>()

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function isBusy(): boolean {
  return turn !== null
}

// ---- 브라우저 쪽 출력 ----

function emit(t: Turn, event: AgentEvent): void {
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
  showNext(t)
}

export function detach(sink: Sink): void {
  if (turn?.sink === sink) turn.sink = null
}

function showNext(t: Turn): void {
  if (t.shown || !t.sink || t.finished) return
  const next = t.queue.shift()
  if (!next) return
  t.shown = next
  t.sink.send(next.event)
  // 브라우저 쪽 스트림은 approval_required로 끝난다(계약 4장). Agent 스트림은 계속 열어 둔다.
  const sink = t.sink
  t.sink = null
  sink.end()
}

function finish(t: Turn): void {
  if (t.finished) return
  t.finished = true
  // 승인 대기 건은 그걸 기다리는 도구 호출보다 오래 살 수 없다(계약 6장).
  for (const ap of approvals.values()) {
    if (ap.status === 'pending' && ap.sessionId === t.sessionId) resolve(ap, 'cancelled', 'turn ended')
  }
  t.sink?.end()
  t.sink = null
  t.abort.abort()
  if (turn === t) turn = null
}

// ---- 턴 시작 ----

export async function startTurn(sessionId: string, text: string): Promise<(sink: Sink) => void> {
  if (turn) throw new HttpError(409, 'BUSY', '다른 작업을 처리하고 있어요. 끝나면 다시 보내주세요.')
  const t: Turn = {
    sessionId,
    index: 0,
    abort: new AbortController(),
    running: new Map(),
    sink: null,
    buffer: [],
    shown: null,
    queue: [],
    finished: false,
  }
  // 기다리는 동안 다른 요청이 끼어들지 않게 먼저 자리를 잡는다.
  turn = t

  let upstream: AsyncGenerator<DAEvent>
  try {
    const session = await agent.getSession(sessionId)
    t.index = (session.messages ?? []).filter((m) => m.message?.role === 'user' && !m.implicit).length
    upstream = await agent.runAgent(sessionId, text, t.abort.signal, currentModel())
  } catch (err) {
    turn = null
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

// 진행 중인 도구 호출을 기억한다. 인자는 승인 카드와 exec 명령 짝짓기에만 쓰고 브라우저로 보내지 않는다.
function track(t: Turn, ev: DAEvent): void {
  if (ev.type === 'tool_call') {
    const call = (ev as Extract<DAEvent, { type: 'tool_call' }>).tool_call
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(call.function.arguments || '{}')
    } catch {
      // 인자를 못 읽어도 호출 추적은 한다.
    }
    if (call.id) t.running.set(call.id, { name: call.function.name ?? '', args })
    return
  }
  if (ev.type === 'tool_call_response') {
    const res = ev as Extract<DAEvent, { type: 'tool_call_response' }>
    const call = t.running.get(res.tool_call_id)
    if (!call) return
    t.running.delete(res.tool_call_id)
    // 도구 호출이 끝났는데 승인이 아직 대기 중이면 거부한다(계약 6장).
    const ap = call.approvalId ? approvals.get(call.approvalId) : undefined
    if (ap?.status === 'pending') resolve(ap, 'cancelled', 'tool call ended')
    rememberExec(call, res.response, res.result?.isError ?? false)
  }
}

function rememberExec(call: RunningCall, response: string, isError: boolean): void {
  if (call.name !== 'proxy_exec' || isError) return
  const command = execCommand(call.args)
  if (!command) return
  try {
    const id = (JSON.parse(response) as { Id?: unknown }).Id
    if (typeof id === 'string') execCommands.set(id, command)
  } catch {
    // exec 생성 응답이 아니면 무시한다.
  }
}

// ---- Airlock 승인 요청 ----

export async function onAirlockRequests(requests: AirlockRequest[]): Promise<void> {
  for (const req of requests) {
    if (seenAirlockIds.has(req.id)) continue
    seenAirlockIds.add(req.id)
    // 다른 Agent의 요청은 건드리지 않는다.
    if (config.airlockAgentId && req.agentId !== config.airlockAgentId) continue
    await register(req)
  }
}

async function register(req: AirlockRequest): Promise<void> {
  const receivedAt = Date.now()
  // webhook이 Agent 스트림의 tool_call보다 먼저 올 수 있어 잠깐 기다린다.
  let match = findCall(req.tool)
  for (let i = 0; !match && i < 4; i++) {
    await new Promise((r) => setTimeout(r, 500))
    match = findCall(req.tool)
  }
  if (!match) {
    console.warn('[airlock] no running tool call for', req.tool, req.id)
    await airlock.deny(req.id, 'no matching tool call').catch((err) => console.error('[airlock] deny failed', err))
    return
  }
  const { t, callId, call } = match

  // timeoutMs는 남은 시간이 아니라 설정값이고, webhook은 모았다가 온다. 그래서 넉넉히 앞당긴다(계약 7.1).
  // 보조 조회로 찾은 건은 timeoutMs가 없고 생성 시각도 모르므로 더 앞당긴다.
  const timeoutMs = req.timeoutMs || AIRLOCK_DEFAULT_TIMEOUT_MS - config.pendingPollMs * 2
  const expiresAt = receivedAt + timeoutMs - config.approvalMarginMs
  const card = approvalCard(req.tool, req.args ?? {}, execCommands)
  const ap: Approval = {
    id: `ap_${randomUUID()}`,
    airlockId: req.id,
    sessionId: t.sessionId,
    tool: req.tool,
    toolCallId: callId,
    status: 'pending',
    event: { type: 'approval_required', approvalId: '', ...card, expiresAt: new Date(expiresAt).toISOString() },
  }
  ap.event.approvalId = ap.id
  approvals.set(ap.id, ap)
  call.approvalId = ap.id
  ap.timer = setTimeout(() => expire(ap), Math.max(0, expiresAt + config.expiryGraceMs - Date.now()))
  addCard(t.sessionId, t.index, { kind: 'approval', approvalId: ap.id, status: 'pending', ...card, expiresAt: ap.event.expiresAt })

  t.queue.push(ap)
  showNext(t)
}

function findCall(tool: string): { t: Turn; callId: string; call: RunningCall } | undefined {
  const t = turn
  if (!t || t.finished) return undefined
  for (const [callId, call] of t.running) {
    if (call.name === tool && !call.approvalId) return { t, callId, call }
  }
  return undefined
}

// denyReason을 주면 Airlock에도 거부를 보낸다. 사용자 결정처럼 이미 Airlock에 보낸 경우에는 주지 않는다.
function resolve(ap: Approval, status: ApprovalStatus, denyReason?: string): void {
  ap.status = status
  clearTimeout(ap.timer)
  updateApprovalCard(ap.id, status)
  if (turn) {
    turn.queue = turn.queue.filter((q) => q !== ap)
    if (turn.shown === ap) turn.shown = null
  }
  if (denyReason !== undefined) {
    airlock.deny(ap.airlockId, denyReason).catch((err) => console.error('[airlock] deny failed', ap.airlockId, err))
  }
}

// 사용자가 없어도 만료되면 거부한다. 이어지는 Agent 출력은 받을 곳이 없으면 버린다(대화 기록에는 남는다).
function expire(ap: Approval): void {
  if (ap.status !== 'pending') return
  resolve(ap, 'expired', 'expired')
  logDecision({ user: 'system', sessionId: ap.sessionId, approvalId: ap.id, airlockId: ap.airlockId, tool: ap.tool, decision: 'expired' })
}

// ---- 사용자 결정 ----

export async function decide(
  sessionId: string,
  approvalId: string,
  decision: ApprovalDecision,
  reason?: string,
): Promise<(sink: Sink) => void> {
  const ap = approvals.get(approvalId)
  if (!ap || ap.sessionId !== sessionId) throw new HttpError(404, 'NO_APPROVAL', '승인 요청을 찾을 수 없어요.')
  const t = turn

  // 서버가 먼저 만료 처리한 뒤 브라우저의 만료 거부가 온 경우: 이어지는 응답만 붙여 준다.
  if (ap.status === 'expired' && decision === 'deny' && reason === 'expired' && t?.sessionId === sessionId) {
    return (sink) => attach(t, sink)
  }
  if (ap.status !== 'pending' || !t || t.shown !== ap) {
    throw new HttpError(409, 'APPROVAL_CLOSED', '이미 처리됐거나 만료된 승인이에요.')
  }

  try {
    if (decision === 'approve') await airlock.approve(ap.airlockId)
    else await airlock.deny(ap.airlockId, reason)
  } catch (err) {
    // Airlock에 대기 건이 없으면(이미 만료) 404가 온다.
    if (err instanceof airlock.AirlockError && err.status === 404) {
      resolve(ap, 'expired')
      throw new HttpError(409, 'APPROVAL_CLOSED', '이미 처리됐거나 만료된 승인이에요.')
    }
    console.error('[airlock] decision failed', err)
    throw new HttpError(502, 'AIRLOCK_UNAVAILABLE', '승인 서버에 연결하지 못했어요. 다시 눌러주세요.')
  }

  const status: ApprovalStatus =
    decision === 'approve' ? 'approved' : reason === 'expired' ? 'expired' : 'denied'
  resolve(ap, status)
  // 로그인을 붙이기 전이라 사용자는 단일 관리자로 기록한다(D4 A-1).
  logDecision({ user: 'admin', sessionId, approvalId, airlockId: ap.airlockId, tool: ap.tool, decision: status })
  return (sink) => attach(t, sink)
}

// ---- 시작 정리와 보조 조회 ----

// 백엔드가 다시 켜지면 기다리는 도구 호출이 없으므로 남은 대기 건을 모두 거부한다(계약 6장).
export async function cleanupPending(): Promise<void> {
  const list = await airlock.pending()
  for (const req of list) {
    if (config.airlockAgentId && req.agentId !== config.airlockAgentId) continue
    seenAirlockIds.add(req.id)
    await airlock.deny(req.id, 'web backend restarted').catch((err) => console.error('[airlock] deny failed', err))
  }
  if (list.length > 0) console.info(`[airlock] cleaned up ${list.length} pending request(s)`)
}

// Airlock은 webhook 전송이 실패해도 다시 보내지 않는다. 도구 실행 중에는 대기 목록을 같이 본다(계약 6장).
export async function pollPending(): Promise<void> {
  if (!turn || turn.running.size === 0) return
  const list = await airlock.pending()
  await onAirlockRequests(list.filter((r) => !seenAirlockIds.has(r.id)))
}
