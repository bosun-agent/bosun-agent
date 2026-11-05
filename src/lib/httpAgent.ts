// WEB 백엔드에 붙는 실제 클라이언트. 목업과 같은 AgentClient 인터페이스라 화면 코드는 그대로다.
// 개발 중에는 Vite가 /api를 백엔드로 넘긴다(vite.config.ts).

import type {
  AgentClient,
  AgentEvent,
  AuditRecord,
  BackupRecord,
  RestoredMessage,
  SessionSummary,
  SessionUsage,
  Settings,
  SystemInfo,
  UsageTotals,
} from './agentProtocol'
import { apiFetch } from './api'
import { readSSE } from './sse'

// 백엔드가 SSE를 열기 전에 거절하면(409, 404, 502 등) JSON으로 사유를 준다.
async function failure(res: Response): Promise<AgentEvent> {
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null
  return {
    type: 'error',
    code: body?.error ?? `HTTP_${res.status}`,
    message: body?.message ?? '서버에 연결하지 못했어요. 잠시 후 다시 시도해주세요.',
  }
}

async function* events(res: Response): AsyncGenerator<AgentEvent> {
  if (!res.ok || !res.body) {
    yield await failure(res)
    return
  }
  let lastType = ''
  for await (const event of readSSE(res.body)) {
    const ev = event as AgentEvent
    lastType = ev.type
    yield ev
  }
  // 끝 이벤트 없이 닫히면 연결이 끊긴 것이다. 화면이 "연결 끊김"으로 보여주도록 던진다.
  // 다시 붙기는 결정한 카드(approval_required) 뒤에도 이어지므로 마지막 이벤트로 판단한다.
  if (!['done', 'error', 'approval_required'].includes(lastType)) throw new Error('stream closed before end event')
}

async function* stream(url: string, body: unknown): AsyncGenerator<AgentEvent> {
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  yield* events(res)
}

const sessionPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}`

async function json<T>(path: string, init?: RequestInit & { body?: string }): Promise<T> {
  const res = await apiFetch(path, init?.body ? { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } } : init)
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} ${res.status}`)
  return (await res.json()) as T
}

async function ok(path: string, init: RequestInit & { body?: string }): Promise<void> {
  const res = await apiFetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } })
  if (!res.ok) throw new Error(`${init.method} ${path} ${res.status}`)
}

export const httpAgent: AgentClient = {
  async createSession() {
    return (await json<{ sessionId: string }>('/api/sessions', { method: 'POST' })).sessionId
  },

  sendMessage(sessionId, text) {
    return stream(`${sessionPath(sessionId)}/messages`, { text })
  },

  sendDecision(sessionId, approvalId, decision, reason) {
    return stream(
      `${sessionPath(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      reason ? { decision, reason } : { decision },
    )
  },

  async *attach(sessionId) {
    yield* events(await apiFetch(`${sessionPath(sessionId)}/stream`))
  },

  async stop(sessionId) {
    const res = await apiFetch(`${sessionPath(sessionId)}/stop`, { method: 'POST' })
    // 이미 끝났으면 멈춘 것으로 본다.
    if (!res.ok && res.status !== 404) throw new Error(`stop ${res.status}`)
  },

  async listSessions() {
    return (await json<{ sessions: SessionSummary[] }>('/api/sessions')).sessions
  },

  async loadMessages(sessionId) {
    const body = await json<{ messages: RestoredMessage[]; running?: boolean }>(`${sessionPath(sessionId)}/messages`)
    return { messages: body.messages, running: body.running === true }
  },

  getSettings: () => json<Settings>('/api/settings'),

  saveModel: (model) => json<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify({ model }) }),

  addModel: (model) => json<Settings>('/api/settings/models', { method: 'POST', body: JSON.stringify({ model }) }),

  removeModel: (model) => json<Settings>(`/api/settings/models?model=${encodeURIComponent(model)}`, { method: 'DELETE' }),

  async deleteSession(sessionId) {
    const res = await apiFetch(sessionPath(sessionId), { method: 'DELETE' })
    // 이미 없는 대화는 지운 것으로 본다.
    if (!res.ok && res.status !== 404) throw new Error(`deleteSession ${res.status}`)
  },

  renameSession: (sessionId, title) => ok(sessionPath(sessionId), { method: 'PATCH', body: JSON.stringify({ title }) }),

  pinSession: (sessionId, pinned) => ok(sessionPath(sessionId), { method: 'PATCH', body: JSON.stringify({ pinned }) }),

  forkSession: (sessionId, turn) =>
    json<{ sessionId: string; title: string }>(`${sessionPath(sessionId)}/fork`, { method: 'POST', body: JSON.stringify({ turn }) }),

  // 쿠키(path /api)로 인증하므로 링크로 바로 내려받는다.
  exportUrl: (sessionId) => `${sessionPath(sessionId)}/export`,

  getUsage: (sessionId) => json<SessionUsage>(`${sessionPath(sessionId)}/usage`),

  getUsageTotals: () => json<UsageTotals>('/api/usage'),

  getSystem: () => json<SystemInfo>('/api/system'),

  async getToolCount() {
    return (await json<{ count: number }>('/api/system/tools')).count
  },

  async getAudit(limit = 100) {
    return (await json<{ records: AuditRecord[] }>(`/api/audit?limit=${limit}`)).records
  },

  getBackups: () => json<{ available: boolean; records: BackupRecord[] }>('/api/backups?limit=200'),

  async saveApiKey(apiKey) {
    return json<Settings>('/api/settings/api-key', { method: 'PUT', body: JSON.stringify({ apiKey }) })
  },
}
