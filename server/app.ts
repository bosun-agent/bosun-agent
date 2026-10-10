// 브라우저 ↔ WEB 백엔드 엔드포인트(계약 3장).

import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ApprovalDecision, RestoredCard, RestoredMessage, SessionSummary } from '../src/lib/agentProtocol.ts'
import * as agent from './agentClient.ts'
import { config } from './config.ts'
import { maskText } from './mask.ts'
import { getSettings, saveApiKey, saveModel, validApiKey } from './settings.ts'
import { cardsFor } from './store.ts'
import { HttpError, decide, detach, startTurn, type Sink } from './turns.ts'

export const app = new Hono()

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.code, message: err.message }, err.status as 400)
  console.error('[web]', err)
  if (err instanceof agent.AgentHttpError) {
    return c.json({ error: 'AGENT_UNAVAILABLE', message: 'AI Agent에 연결하지 못했어요.' }, 502)
  }
  return c.json({ error: 'INTERNAL', message: '서버 오류가 났어요.' }, 500)
})

// SSE 응답을 열고 턴에 붙인다. 브라우저가 끊고 나가도 턴은 계속 돈다(출력은 모았다가 버린다).
function streamTo(c: Context, attach: (sink: Sink) => void) {
  // 리버스 프록시가 응답을 모아 두지 않게 한다(계약 7.1).
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    let open = true
    let closed!: () => void
    const done = new Promise<void>((r) => (closed = r))
    // 쓰기를 차례로 잇는다. 마지막 이벤트를 다 쓰기 전에 응답을 닫으면 done이 사라진다.
    let writes = Promise.resolve()
    const write = (fn: () => Promise<unknown>) => {
      writes = writes.then(fn).then(
        () => undefined,
        () => undefined,
      )
    }
    const ping = setInterval(() => write(() => stream.write(': ping\n\n')), config.pingMs)
    const close = () => {
      if (!open) return
      open = false
      clearInterval(ping)
      void writes.then(closed)
    }
    const sink: Sink = {
      send: (event) => {
        if (open) write(() => stream.writeSSE({ data: JSON.stringify(event) }))
      },
      end: close,
    }
    stream.onAbort(() => {
      detach(sink)
      close()
    })
    attach(sink)
    await done
  })
}

// ---- 브라우저용 /api ----

app.post('/api/sessions', async (c) => {
  const sessionId = await agent.createSession()
  return c.json({ sessionId }, 201)
})

app.get('/api/sessions', async (c) => {
  const list = await agent.listSessions()
  const sessions: SessionSummary[] = list
    .map((s) => ({ sessionId: s.id, title: s.title, updatedAt: s.created_at }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return c.json({ sessions })
})

// 대화 복원(계약 3장). 사용자·Agent 문장만 내보내고 도구 인자·결과 원본은 내보내지 않는다(계약 5장 4항).
app.get('/api/sessions/:id/messages', async (c) => {
  const sessionId = c.req.param('id')
  const session = await agent.getSession(sessionId).catch((err) => {
    if (err instanceof agent.AgentHttpError && err.status === 404) {
      throw new HttpError(404, 'NO_SESSION', '대화를 찾을 수 없어요.')
    }
    throw err
  })

  // 사용자 메시지 하나와 그 뒤 Agent 문장들을 한 턴으로 묶는다. 카드는 턴 번호로 붙인다.
  const turns: { user: string; reply: string[]; cards: RestoredCard[] }[] = []
  for (const item of session.messages ?? []) {
    const m = item.message
    if (!m || item.implicit) continue
    if (m.role === 'user') turns.push({ user: m.content ?? '', reply: [], cards: [] })
    else if (m.role === 'assistant' && m.content) turns.at(-1)?.reply.push(maskText(m.content))
  }
  for (const { turn, card } of cardsFor(sessionId)) turns[turn]?.cards.push(card)

  const messages: RestoredMessage[] = turns.flatMap((t): RestoredMessage[] => [
    { role: 'user', content: t.user },
    ...(t.reply.length || t.cards.length
      ? [{ role: 'assistant' as const, content: t.reply.join('\n'), ...(t.cards.length ? { cards: t.cards } : {}) }]
      : []),
  ])
  return c.json({ messages })
})

app.post('/api/sessions/:id/messages', async (c) => {
  const body = await c.req.json<{ text?: unknown }>().catch(() => ({}) as { text?: unknown })
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    throw new HttpError(400, 'BAD_REQUEST', '보낼 내용이 없어요.')
  }
  const attach = await startTurn(c.req.param('id'), body.text)
  return streamTo(c, attach)
})

app.post('/api/sessions/:id/approvals/:approvalId', async (c) => {
  const body = await c.req
    .json<{ decision?: unknown; reason?: unknown }>()
    .catch(() => ({}) as { decision?: unknown; reason?: unknown })
  if (body.decision !== 'approve' && body.decision !== 'deny') {
    throw new HttpError(400, 'BAD_REQUEST', 'decision은 approve 또는 deny여야 해요.')
  }
  // reason은 만료 거부("expired")만 받는다. 그 밖의 값은 버린다.
  const reason = body.decision === 'deny' && body.reason === 'expired' ? 'expired' : undefined
  const attach = await decide(c.req.param('id'), c.req.param('approvalId'), body.decision as ApprovalDecision, reason)
  return streamTo(c, attach)
})

// 설정 화면(계약 3장). 모델 선택과 API 키.
app.get('/api/settings', (c) => c.json(getSettings()))

app.put('/api/settings', async (c) => {
  const body = await c.req.json<{ model?: unknown }>().catch(() => ({}) as { model?: unknown })
  if (typeof body.model !== 'string' || !saveModel(body.model)) {
    throw new HttpError(400, 'BAD_REQUEST', '고를 수 없는 모델이에요.')
  }
  return c.json(getSettings())
})

// API 키는 Docker Agent env 파일에 쓴다. Agent를 다시 시작해야 적용된다(계약 7장 ①).
app.put('/api/settings/api-key', async (c) => {
  if (!config.agentEnvFile) throw new HttpError(409, 'NOT_EDITABLE', 'API 키를 바꿀 수 없게 설정돼 있어요.')
  const body = await c.req.json<{ apiKey?: unknown }>().catch(() => ({}) as { apiKey?: unknown })
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : undefined
  if (!validApiKey(apiKey)) throw new HttpError(400, 'BAD_REQUEST', 'API 키 형식이 올바르지 않아요.')
  saveApiKey(apiKey)
  console.info(`[settings] ${config.agentKeyName} updated; restart Docker Agent to apply`)
  return c.json(getSettings())
})
