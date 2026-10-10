// WEB 백엔드에 붙는 실제 클라이언트. 목업과 같은 AgentClient 인터페이스라 화면 코드는 그대로다.
// 개발 중에는 Vite가 /api를 백엔드로 넘긴다(vite.config.ts).

import type { AgentClient, AgentEvent, RestoredMessage, SessionSummary, Settings } from './agentProtocol'
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

async function* stream(url: string, body: unknown): AsyncGenerator<AgentEvent> {
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    yield await failure(res)
    return
  }
  let ended = false
  for await (const event of readSSE(res.body)) {
    const ev = event as AgentEvent
    if (ev.type === 'done' || ev.type === 'error' || ev.type === 'approval_required') ended = true
    yield ev
  }
  // 끝 이벤트 없이 닫히면 연결이 끊긴 것이다. 화면이 "연결 끊김"으로 보여주도록 던진다.
  if (!ended) throw new Error('stream closed before end event')
}

export const httpAgent: AgentClient = {
  async createSession() {
    const res = await apiFetch('/api/sessions', { method: 'POST' })
    if (!res.ok) throw new Error(`createSession ${res.status}`)
    return ((await res.json()) as { sessionId: string }).sessionId
  },

  sendMessage(sessionId, text) {
    return stream(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { text })
  },

  sendDecision(sessionId, approvalId, decision, reason) {
    return stream(
      `/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      reason ? { decision, reason } : { decision },
    )
  },

  async listSessions() {
    const res = await apiFetch('/api/sessions')
    if (!res.ok) throw new Error(`listSessions ${res.status}`)
    return ((await res.json()) as { sessions: SessionSummary[] }).sessions
  },

  async loadMessages(sessionId) {
    const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
    if (!res.ok) throw new Error(`loadMessages ${res.status}`)
    return ((await res.json()) as { messages: RestoredMessage[] }).messages
  },

  async getSettings() {
    const res = await apiFetch('/api/settings')
    if (!res.ok) throw new Error(`getSettings ${res.status}`)
    return (await res.json()) as Settings
  },

  async saveModel(model) {
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    })
    if (!res.ok) throw new Error(`saveModel ${res.status}`)
    return (await res.json()) as Settings
  },

  async deleteSession(sessionId) {
    const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
    // 이미 없는 대화는 지운 것으로 본다.
    if (!res.ok && res.status !== 404) throw new Error(`deleteSession ${res.status}`)
  },

  async saveApiKey(apiKey) {
    const res = await apiFetch('/api/settings/api-key', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    })
    if (!res.ok) throw new Error(`saveApiKey ${res.status}`)
    return (await res.json()) as Settings
  },
}
