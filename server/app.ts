// 브라우저 ↔ WEB 백엔드 엔드포인트(계약 3장).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { streamSSE } from 'hono/streaming'
import type {
  ApprovalDecision,
  AuditRecord,
  RestoredCard,
  RestoredMessage,
  SessionSummary,
  SessionUsage,
  UsageTotals,
} from '../src/lib/agentProtocol.ts'
import * as agent from './agentClient.ts'
import { listBackups } from './backups.ts'
import { config } from './config.ts'
import { LOCAL_USER, localOnly } from './guard.ts'
import { maskText } from './mask.ts'
import { addModel, getSettings, removeModel, saveApiKey, saveModel, validApiKey, validModelRef } from './settings.ts'
import { cardSummaries, cardsFor, copyCards, deleteCards, pinnedSessions, recentDecisions, setPinned, usageSince } from './store.ts'
import { systemInfo } from './system.ts'
import {
  HttpError,
  decide,
  detach,
  isRunning,
  reattach,
  runningCount,
  runningIndex,
  startTurn,
  stopTurn,
  type Sink,
} from './turns.ts'

export const app = new Hono()

// 보안 헤더. 화면은 같은 출처의 스크립트와 /api만 쓴다. 마크다운의 HTML·이미지는 그리지 않지만(계약 7.1)
// 화면에 섞인 외부 문자열이 스크립트로 실행되는 경우에 대비해 CSP로 한 번 더 막는다.
// style 'unsafe-inline'은 React style 속성(애니메이션 지연) 때문이다.
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  }),
)

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.code, message: err.message }, err.status as 400)
  console.error('[web]', err)
  if (err instanceof agent.AgentHttpError) {
    return c.json({ error: 'AGENT_UNAVAILABLE', message: 'AI Agent에 연결하지 못했어요.' }, 502)
  }
  return c.json({ error: 'INTERNAL', message: '서버 오류가 났어요.' }, 500)
})

// SSE 응답을 열고 턴에 붙인다. 브라우저가 끊고 나가도 턴은 계속 돈다(출력은 모았다가 다시 붙을 때 보낸다).
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

async function jsonBody<T extends object>(c: Context): Promise<Partial<T>> {
  return c.req.json<Partial<T>>().catch(() => ({}) as Partial<T>)
}

function notFound(err: unknown): never {
  if (err instanceof agent.AgentHttpError && err.status === 404) {
    throw new HttpError(404, 'NO_SESSION', '대화를 찾을 수 없어요.')
  }
  throw err
}

// 처리 중인 대화를 바꾸는 요청(삭제, 복제)을 막는다.
function requireIdle(sessionId: string): void {
  if (isRunning(sessionId)) throw new HttpError(409, 'BUSY', '처리 중인 대화는 바꿀 수 없어요. 끝나거나 멈춘 뒤 다시 해주세요.')
}

// ---- 브라우저용 /api ----

// 이 PC의 화면만 부른다(server/guard.ts).
app.use('/api/*', localOnly)

app.post('/api/sessions', async (c) => {
  const sessionId = await agent.createSession()
  return c.json({ sessionId }, 201)
})

app.get('/api/sessions', async (c) => {
  const list = await agent.listSessions()
  const pins = pinnedSessions()
  const sessions: SessionSummary[] = list
    .map((s) => ({
      sessionId: s.id,
      title: s.title,
      updatedAt: s.created_at,
      ...(isRunning(s.id) ? { running: true } : {}),
      ...(pins.has(s.id) ? { pinned: true } : {}),
      inputTokens: s.input_tokens ?? 0,
      outputTokens: s.output_tokens ?? 0,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return c.json({ sessions })
})

// 사용자 메시지 하나와 그 뒤 Agent 문장들을 한 턴으로 묶는다. 카드는 턴 번호로 붙인다.
// 처리 중인 턴은 Agent 문장과 카드를 빼고 사용자 메시지만 둔다. 화면이 다시 붙어서 처음부터 받는다.
async function restoredMessages(sessionId: string): Promise<{ title: string; messages: RestoredMessage[]; running: boolean }> {
  const session = await agent.getSession(sessionId).catch(notFound)
  const running = runningIndex(sessionId)
  const turns: { user: string; reply: string[]; cards: RestoredCard[] }[] = []
  for (const item of session.messages ?? []) {
    const m = item.message
    if (!m || item.implicit) continue
    if (m.role === 'user') turns.push({ user: m.content ?? '', reply: [], cards: [] })
    else if (m.role === 'assistant' && m.content && turns.length - 1 !== running) turns.at(-1)?.reply.push(maskText(m.content))
  }
  for (const { turn, card } of cardsFor(sessionId)) if (turn !== running) turns[turn]?.cards.push(card)

  const messages: RestoredMessage[] = turns.flatMap((t): RestoredMessage[] => [
    { role: 'user', content: t.user },
    ...(t.reply.length || t.cards.length
      ? [{ role: 'assistant' as const, content: t.reply.join('\n\n'), ...(t.cards.length ? { cards: t.cards } : {}) }]
      : []),
  ])
  return { title: session.title, messages, running: running !== undefined }
}

// 대화 복원(계약 3장). 사용자·Agent 문장만 내보내고 도구 인자·결과 원본은 내보내지 않는다(계약 5장 4항).
app.get('/api/sessions/:id/messages', async (c) => {
  const { messages, running } = await restoredMessages(c.req.param('id'))
  return c.json({ messages, ...(running ? { running: true } : {}) })
})

// 새로고침한 화면이 처리 중인 턴에 다시 붙는다. 이 턴의 이벤트를 처음부터 보내고 이어서 보낸다.
app.get('/api/sessions/:id/stream', (c) => streamTo(c, reattach(c.req.param('id'))))

// 처리를 멈춘다. 붙어 있는 화면에는 error(STOPPED)로 스트림이 끝난다.
app.post('/api/sessions/:id/stop', (c) => {
  stopTurn(c.req.param('id'))
  return c.body(null, 204)
})

// 제목 바꾸기와 고정. 제목은 Docker Agent 대화에 저장된다.
app.patch('/api/sessions/:id', async (c) => {
  const sessionId = c.req.param('id')
  const body = await jsonBody<{ title: unknown; pinned: unknown }>(c)
  if (body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : ''
    if (!title || title.length > 100) throw new HttpError(400, 'BAD_REQUEST', '제목은 1~100자로 적어주세요.')
    await agent.setTitle(sessionId, title).catch(notFound)
  }
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== 'boolean') throw new HttpError(400, 'BAD_REQUEST', 'pinned는 true 또는 false예요.')
    await agent.getSession(sessionId).catch(notFound)
    setPinned(sessionId, body.pinned)
  }
  return c.body(null, 204)
})

// turn번째 사용자 메시지(0부터) 직전까지를 복사한 새 대화를 만든다. 그 메시지를 고쳐 다시 보낼 때 쓴다.
app.post('/api/sessions/:id/fork', async (c) => {
  const sessionId = c.req.param('id')
  requireIdle(sessionId)
  const body = await jsonBody<{ turn: unknown }>(c)
  const turn = body.turn
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) {
    throw new HttpError(400, 'BAD_REQUEST', 'turn은 0 이상의 정수예요.')
  }
  // WEB의 턴 번호는 implicit 메시지를 뺀 사용자 메시지 순서다. Docker Agent의 순서는 implicit을 포함한다.
  const session = await agent.getSession(sessionId).catch(notFound)
  let ordinal = 0
  let seen = 0
  let found = false
  for (const item of session.messages ?? []) {
    if (item.message?.role !== 'user') continue
    if (!item.implicit) {
      if (seen === turn) {
        found = true
        break
      }
      seen++
    }
    ordinal++
  }
  if (!found) throw new HttpError(400, 'BAD_REQUEST', '그 메시지를 찾을 수 없어요.')
  const forkId = await agent.forkSession(sessionId, ordinal)
  copyCards(sessionId, forkId, turn)
  const fork = await agent.getSession(forkId)
  return c.json({ sessionId: forkId, title: fork.title }, 201)
})

// 대화를 마크다운으로 내려받는다. 복원과 같은 내용(가린 문장, 카드 결과)만 담는다.
const DECISION_LABEL: Record<string, string> = {
  pending: '결정 대기',
  approved: '승인함',
  denied: '거부함',
  expired: '시간이 지나 취소됨',
  cancelled: '취소됨',
}

app.get('/api/sessions/:id/export', async (c) => {
  const sessionId = c.req.param('id')
  const { title, messages } = await restoredMessages(sessionId)
  const lines = [`# ${title || '제목 없음'}`, '', `내보낸 시각: ${new Date().toISOString()}`, '']
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push('## 사용자', '', m.content, '')
      continue
    }
    lines.push('## BOSUN', '')
    for (const card of m.cards ?? []) {
      if (card.kind === 'rejected') lines.push(`> 정책 차단: ${card.reason}${card.detail ? ` (${card.detail})` : ''}`, '')
      else lines.push(`> 승인 요청: ${card.summary} — ${DECISION_LABEL[card.status] ?? card.status}`, '')
    }
    if (m.content) lines.push(m.content, '')
  }
  const filename = `bosun-${sessionId.slice(0, 8)}.md`
  c.header('Content-Disposition', `attachment; filename="${filename}"`)
  return c.body(lines.join('\n'), 200, { 'Content-Type': 'text/markdown; charset=utf-8' })
})

// 대화 사용량. 비용은 Docker Agent가 모델 가격표로 계산한 값이다(달러).
app.get('/api/sessions/:id/usage', async (c) => {
  const snap = await agent.getSnapshot(c.req.param('id')).catch(notFound)
  const usage: SessionUsage = {
    inputTokens: snap.input_tokens ?? 0,
    outputTokens: snap.output_tokens ?? 0,
    ...(typeof snap.cost === 'number' ? { cost: snap.cost } : {}),
  }
  return c.json(usage)
})

// 전체 사용량(오늘, 이번 달, 전체). 턴마다 WEB이 기록한 값의 합이라 대화를 지워도 남는다.
// 날짜 경계는 WEB 백엔드가 도는 서버의 시간대를 따른다.
app.get('/api/usage', (c) => {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const month = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const totals: UsageTotals = { today: usageSince(today), month: usageSince(month), total: usageSince() }
  return c.json(totals)
})

// 대화 삭제. 처리 중(승인 대기 포함)인 대화는 지우지 않는다. 승인 감사 기록은 남긴다(계약 7.1).
app.delete('/api/sessions/:id', async (c) => {
  const sessionId = c.req.param('id')
  if (isRunning(sessionId)) throw new HttpError(409, 'BUSY', '처리 중인 대화는 지울 수 없어요.')
  await agent.deleteSession(sessionId).catch(notFound)
  deleteCards(sessionId)
  return c.body(null, 204)
})

app.post('/api/sessions/:id/messages', async (c) => {
  const body = await jsonBody<{ text: unknown }>(c)
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    throw new HttpError(400, 'BAD_REQUEST', '보낼 내용이 없어요.')
  }
  if (body.text.length > config.maxMessageChars) {
    throw new HttpError(400, 'TOO_LONG', `메시지는 ${config.maxMessageChars.toLocaleString()}자까지 보낼 수 있어요.`)
  }
  const attach = await startTurn(c.req.param('id'), body.text)
  return streamTo(c, attach)
})

app.post('/api/sessions/:id/approvals/:approvalId', async (c) => {
  const body = await jsonBody<{ decision: unknown; reason: unknown }>(c)
  if (body.decision !== 'approve' && body.decision !== 'deny') {
    throw new HttpError(400, 'BAD_REQUEST', 'decision은 approve 또는 deny여야 해요.')
  }
  // reason은 만료 거부("expired")만 받는다. 그 밖의 값은 버린다.
  const reason = body.decision === 'deny' && body.reason === 'expired' ? 'expired' : undefined
  const attach = await decide(c.req.param('id'), c.req.param('approvalId'), body.decision as ApprovalDecision, LOCAL_USER, reason)
  return streamTo(c, attach)
})

// 설정 화면(계약 3장). 모델 선택과 API 키.
app.get('/api/settings', (c) => c.json(getSettings()))

app.put('/api/settings', async (c) => {
  const body = await jsonBody<{ model: unknown }>(c)
  if (typeof body.model !== 'string' || !saveModel(body.model)) {
    throw new HttpError(400, 'BAD_REQUEST', '고를 수 없는 모델이에요.')
  }
  return c.json(getSettings())
})

// 고를 수 있는 모델을 더한다. 실제로 있는 모델인지는 그 모델로 보낼 때 Agent가 확인한다.
app.post('/api/settings/models', async (c) => {
  const body = await jsonBody<{ model: unknown }>(c)
  const model = typeof body.model === 'string' ? body.model.trim() : undefined
  if (!validModelRef(model)) {
    throw new HttpError(400, 'BAD_REQUEST', '모델은 agent.yaml 모델 이름이나 provider/model 형식으로 적어주세요.')
  }
  addModel(model)
  return c.json(getSettings())
})

app.delete('/api/settings/models', (c) => {
  const model = c.req.query('model') ?? ''
  if (!removeModel(model)) throw new HttpError(400, 'BAD_REQUEST', '화면에서 더한 모델만 지울 수 있어요.')
  return c.json(getSettings())
})

// API 키는 Docker Agent env 파일에 쓴다. Agent를 다시 시작해야 적용된다(계약 7장 ①).
app.put('/api/settings/api-key', async (c) => {
  if (!config.agentEnvFile) throw new HttpError(409, 'NOT_EDITABLE', 'API 키를 바꿀 수 없게 설정돼 있어요.')
  const body = await jsonBody<{ apiKey: unknown }>(c)
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : undefined
  if (!validApiKey(apiKey)) throw new HttpError(400, 'BAD_REQUEST', 'API 키 형식이 올바르지 않아요.')
  saveApiKey(apiKey)
  console.info(`[settings] ${config.agentKeyName} updated; restart Docker Agent to apply`)
  return c.json(getSettings())
})

// 정보·정책 화면. Docker Agent 상태와 agent.yaml 요약(server/system.ts).
app.get('/api/system', async (c) => c.json(await systemInfo(runningCount())))

// 모델이 쓸 수 있는 도구 수. Docker Agent가 MCP 서버를 띄워서 세므로 느릴 수 있어 따로 부른다.
app.get('/api/system/tools', async (c) => {
  const info = await systemInfo(runningCount())
  const name = info.config?.agents[0]?.name ?? 'root'
  return c.json({ agent: name, count: await agent.toolCount(name) })
})

// 삭제 전 백업 목록(최근 순). Agent 백업 훅의 SQLite를 읽기만 한다(server/backups.ts).
app.get('/api/backups', (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 500)
  try {
    return c.json(listBackups(limit))
  } catch (err) {
    console.error('[backups] read failed', err)
    throw new HttpError(500, 'BACKUP_READ_FAILED', '백업 파일을 읽지 못했어요.')
  }
})

// 승인 기록(최근 순). sessionId를 주면 그 대화만.
app.get('/api/audit', (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 500)
  const entries = recentDecisions(limit, c.req.query('sessionId') || undefined)
  const cards = cardSummaries(entries.map((e) => e.approvalId))
  const records: AuditRecord[] = entries.map((e) => ({
    at: e.at,
    user: e.user,
    sessionId: e.sessionId,
    approvalId: e.approvalId,
    tool: e.tool,
    decision: e.decision,
    ...cards.get(e.approvalId),
  }))
  return c.json({ records })
})

// ---- 화면 파일 ----
// 배포할 때는 WEB 백엔드가 빌드한 화면(dist/)도 같이 내보낸다(STATIC_DIR). 개발 중에는 Vite가 화면을 맡는다.
// 화면은 한 페이지라 /api가 아닌 경로는 모두 index.html을 준다.
if (config.staticDir) {
  const root = config.staticDir
  const index = readFileSync(join(root, 'index.html'), 'utf8')
  app.use(
    '/assets/*',
    serveStatic({
      root,
      // 파일 이름에 내용 해시가 들어 있어서 오래 둬도 된다.
      onFound: (_path, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable'),
    }),
  )
  app.use('/*', serveStatic({ root }))
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'NOT_FOUND', message: '없는 주소예요.' }, 404)
    c.header('Cache-Control', 'no-store')
    return c.html(index)
  })
}
