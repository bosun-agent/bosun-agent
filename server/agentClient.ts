// Docker Agent API 서버 클라이언트.
// 승인 절차를 끄거나 바꾸는 엔드포인트(tools/toggle, safety-policy, permissions)는 부르지 않는다.
// resume은 approve와 reject만 보낸다. approve-tool 등은 세션 권한을 넓힌다.

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { readSSE } from '../src/lib/sse.ts'
import { config } from './config.ts'

// 승인 카드 설명 훅(Agent 담당 tool_guard_approval_explainer.py)이 승인 이벤트에 붙이는 값.
export interface HookExplanation {
  reason?: string
  blast_radius?: string
  category?: string
}

// Docker Agent 이벤트 중 WEB 백엔드가 읽는 필드만 적었다(docker/docker-agent pkg/runtime/event.go).
export interface DAToolCall {
  id?: string
  function: { name?: string; arguments?: string }
}

export type DAEvent =
  | { type: 'mcp_init_started' | 'mcp_init_finished' | 'stream_started' }
  | { type: 'agent_choice'; content: string }
  | { type: 'tool_call'; tool_call: DAToolCall }
  | {
      type: 'tool_call_response'
      tool_call_id: string
      tool_definition?: { name?: string }
      response: string
      result?: { output: string; isError?: boolean }
    }
  | { type: 'tool_call_confirmation'; tool_call: DAToolCall; tool_definition?: { name?: string }; metadata?: HookExplanation }
  | { type: 'max_iterations_reached' }
  | { type: 'elicitation_request' }
  | { type: 'error'; error: string; code?: string }
  | { type: 'stream_stopped'; reason?: string }
  | { type: string }

export interface DASessionSummary {
  id: string
  title: string
  created_at: string
  num_messages?: number
  input_tokens?: number
  output_tokens?: number
}

// GET /api/sessions/:id/snapshot 중 WEB이 읽는 값(v1.148.0 pkg/api/types.go SessionSnapshotResponse)
export interface DASnapshot {
  input_tokens?: number
  output_tokens?: number
  // 누적 비용(달러). 하위 세션과 요약 비용까지 들어 있다.
  cost?: number
}

export interface DAChatMessage {
  role: string
  content?: string
}

export interface DASession {
  id: string
  title: string
  messages?: { message?: DAChatMessage; implicit?: boolean }[]
}

export class AgentHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function headers(json = true): Record<string, string> {
  const h: Record<string, string> = {}
  if (json) h['Content-Type'] = 'application/json'
  if (config.agentToken) h.Authorization = `Bearer ${config.agentToken}`
  return h
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${config.agentUrl}${path}`, {
    ...init,
    headers: { ...headers(init.body !== undefined), ...init.headers },
  })
  if (!res.ok) {
    throw new AgentHttpError(res.status, `Docker Agent ${path} ${res.status}: ${await res.text()}`)
  }
  return res
}

// 새 대화의 임시 제목. 제목이 비어 있으면 Docker Agent가 사용자 입력으로 LLM을 불러 제목을 짓는데, 그 호출에는 보안 훅이 걸리지 않는다.
// 첫 메시지를 보낼 때 turns.ts가 진짜 제목으로 바꾼다.
export const NEW_SESSION_TITLE = '새 대화'

export async function createSession(): Promise<string> {
  // safety_policy를 보내지 않는다. 정책은 agent.yaml(`safety`, `permissions`) 한 곳에서 정한다.
  const res = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ title: NEW_SESSION_TITLE }) })
  const session = (await res.json()) as { id: string }
  return session.id
}

export async function listSessions(): Promise<DASessionSummary[]> {
  const res = await request('/api/sessions')
  return (await res.json()) as DASessionSummary[]
}

export async function deleteSession(id: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 제목이 있으면 Docker Agent는 제목을 만드는 LLM 호출을 따로 하지 않는다(v1.148.0 session_manager.go needsTitle).
export async function setTitle(id: string, title: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(id)}/title`, { method: 'PATCH', body: JSON.stringify({ title }) })
}

export async function getSession(id: string): Promise<DASession> {
  const res = await request(`/api/sessions/${encodeURIComponent(id)}`)
  return (await res.json()) as DASession
}

export async function getSnapshot(id: string): Promise<DASnapshot> {
  const res = await request(`/api/sessions/${encodeURIComponent(id)}/snapshot`)
  return (await res.json()) as DASnapshot
}

// ordinal번째 사용자 메시지(implicit 포함, 0부터) 직전까지를 복사한 새 대화를 만든다(v1.148.0 session/branch.go ForkSession).
export async function forkSession(id: string, ordinal: number): Promise<string> {
  const res = await request(`/api/sessions/${encodeURIComponent(id)}/fork`, {
    method: 'POST',
    body: JSON.stringify({ user_message_index: ordinal }),
  })
  return ((await res.json()) as { id: string }).id
}

// ---- 상태 점검(설정의 정보 화면) ----

export async function health(): Promise<{ status: string; version?: string }> {
  const res = await request('/health')
  return (await res.json()) as { status: string; version?: string }
}

export async function ready(): Promise<{ ready: boolean; active_sessions?: number; latest_error?: string }> {
  // 준비가 안 됐으면 503과 같은 모양으로 온다.
  const res = await fetch(`${config.agentUrl}/ready`, { headers: headers(false) })
  return (await res.json()) as { ready: boolean; active_sessions?: number; latest_error?: string }
}

// agent.yaml 내용(JSON). 이름은 파일 이름이다(agent.direct.yaml → agent.direct). 화면에는 고른 필드만 보낸다(server/system.ts).
export async function getAgentConfig(): Promise<unknown> {
  const res = await request(`/api/agents/${encodeURIComponent(config.agentName)}`)
  return await res.json()
}

// 모델이 쓸 수 있는 도구 수. MCP 서버를 띄워 보고 센다.
export async function toolCount(agentName: string): Promise<number> {
  const res = await request(
    `/api/agents/${encodeURIComponent(config.agentName)}/${encodeURIComponent(agentName)}/tools/count`,
  )
  return ((await res.json()) as { available_tools: number }).available_tools
}

// Agent 스트림은 fetch 대신 node:http로 연다. Node fetch(undici)는 본문이 300초 동안 오지 않으면 끊는데
// (bodyTimeout, 실측 2026-10-09), Docker Agent는 승인 대기나 오래 걸리는 도구 호출 중에 아무것도 보내지 않는다.
// node:http 클라이언트에는 기본 타임아웃이 없다. 끊으면 Docker Agent도 실행을 취소하므로 끊는 건 signal로만 한다.
function openStream(path: string, body: unknown, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const url = new URL(`${config.agentUrl}${path}`)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = send(url, { method: 'POST', headers: headers(), signal }, (res) => {
      const status = res.statusCode ?? 0
      if (status < 400) {
        resolve(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>)
        return
      }
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (text += chunk))
      res.on('end', () => reject(new AgentHttpError(status, `Docker Agent ${path} ${status}: ${text}`)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

// 메시지를 보내고 응답 스트림을 연다. 같은 이름의 Docker Agent `.../messages`는 모델을 부르지 않으므로 쓰지 않는다.
// model을 주면 이 대화의 모델을 바꾼다. Docker Agent가 대화에 저장하므로 다음 턴도 같은 모델을 쓴다.
export async function runAgent(
  sessionId: string,
  text: string,
  signal: AbortSignal,
  model?: string,
  agentName: string = config.agentName,
): Promise<AsyncGenerator<DAEvent>> {
  const body = await openStream(
    `/api/sessions/${encodeURIComponent(sessionId)}/agent/${encodeURIComponent(agentName)}`,
    { messages: [{ role: 'user', content: text }], ...(model ? { model } : {}) },
    signal,
  )
  return readSSE(body) as AsyncGenerator<DAEvent>
}

// 승인 대기 중인 도구 호출에 결정을 보낸다. Docker Agent는 기다리는 건이 없으면 200을 주고 버린다.
// 요청에 도구 호출 ID가 없어서, 지금 기다리는 건 하나에 적용된다.
export async function resume(sessionId: string, confirmation: 'approve' | 'reject', reason?: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, {
    method: 'POST',
    body: JSON.stringify({ confirmation, ...(reason ? { reason } : {}) }),
  })
}
