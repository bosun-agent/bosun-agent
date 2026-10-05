// Airlock management API 클라이언트(airlock-bot 0.2.38 `dist/hitl/api.js`).
// 항상 UUID(id)로 부른다. code로 부르는 경로는 처리된 건에도 200을 돌려주므로 쓰지 않는다(계약 5장 2항).

import { config } from './config.ts'

// webhook의 requests[]와 GET /hitl/pending 항목은 같은 모양이다(계약 8.2).
// pending에는 timeoutMs·badgeCount가 없다.
export interface AirlockRequest {
  id: string
  code: string
  agentId: string
  tool: string
  args: Record<string, unknown>
  timeoutMs?: number
  context?: { reason?: string; note?: string }
}

export interface AirlockWebhookBody {
  requests: AirlockRequest[]
  text: string
}

export class AirlockError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${config.airlockUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.airlockSecret}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new AirlockError(res.status, `Airlock ${path} ${res.status}: ${await res.text()}`)
  return res.json()
}

export async function approve(id: string): Promise<void> {
  await call('POST', `/hitl/approve/${encodeURIComponent(id)}`)
}

export async function deny(id: string, reason?: string): Promise<void> {
  await call('POST', `/hitl/deny/${encodeURIComponent(id)}`, reason ? { reason } : {})
}

export async function pending(): Promise<AirlockRequest[]> {
  return (await call('GET', '/hitl/pending')) as AirlockRequest[]
}
