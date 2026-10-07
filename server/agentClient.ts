// Docker Agent API 서버 클라이언트. 엔드포인트 대응은 인터페이스 계약 8.1에 있다.
// 승인 절차를 끄거나 바꾸는 엔드포인트(tools/toggle, safety-policy, permissions, resume 등)는 여기서 부르지 않는다.

import { readSSE } from '../src/lib/sse.ts'
import { config } from './config.ts'

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
  | { type: 'tool_call_confirmation'; tool_call: DAToolCall }
  | { type: 'elicitation_request' }
  | { type: 'error'; error: string; code?: string }
  | { type: 'stream_stopped'; reason?: string }
  | { type: string }

export interface DASessionSummary {
  id: string
  title: string
  created_at: string
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

export async function createSession(): Promise<string> {
  // 안전 모드를 명시한다. Airlock을 거치는 도구는 agent.yaml의 permissions.allow로 열려 있어야 한다(계약 6장).
  const res = await request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ safety_policy: 'restricted' }),
  })
  const session = (await res.json()) as { id: string }
  return session.id
}

export async function listSessions(): Promise<DASessionSummary[]> {
  const res = await request('/api/sessions')
  return (await res.json()) as DASessionSummary[]
}

export async function getSession(id: string): Promise<DASession> {
  const res = await request(`/api/sessions/${encodeURIComponent(id)}`)
  return (await res.json()) as DASession
}

// 메시지를 보내고 응답 스트림을 연다. 같은 이름의 Docker Agent `.../messages`는 모델을 부르지 않으므로 쓰지 않는다(계약 8.1).
// fetch는 응답 헤더까지만 기다리므로, 승인 대기 중 이벤트가 끊겨도 본문 읽기는 타임아웃 없이 기다린다(계약 7.1).
// model을 주면 이 대화의 모델을 바꾼다. Docker Agent가 대화에 저장하므로 다음 턴도 같은 모델을 쓴다.
export async function runAgent(
  sessionId: string,
  text: string,
  signal: AbortSignal,
  model?: string,
): Promise<AsyncGenerator<DAEvent>> {
  const res = await request(
    `/api/sessions/${encodeURIComponent(sessionId)}/agent/${encodeURIComponent(config.agentName)}`,
    {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: text }], ...(model ? { model } : {}) }),
      signal,
    },
  )
  if (!res.body) throw new AgentHttpError(502, 'Docker Agent stream has no body')
  return readSSE(res.body) as AsyncGenerator<DAEvent>
}
