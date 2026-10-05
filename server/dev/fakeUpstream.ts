// 개발용 가짜 Docker Agent + Airlock. LLM이나 Portainer 없이 WEB 백엔드 흐름을 끝까지 돌려 보려고 쓴다.
// 이벤트·응답 모양은 실제 소스(docker-agent pkg/runtime/event.go, airlock-bot 0.2.38 hitl)를 따른다.
// 실행: npm run server:fake → 메시지 내용의 키워드로 시나리오를 고른다(아래 SCENARIOS).

import { randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'

const agentPort = Number(new URL(process.env.AGENT_URL ?? 'http://127.0.0.1:8080').port)
const airlockPort = Number(new URL(process.env.AIRLOCK_MGMT_URL ?? 'http://127.0.0.1:4113').port)
const secret = process.env.AIRLOCK_MGMT_SECRET ?? ''
const webhookUrl = process.env.FAKE_WEBHOOK_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3001}/internal/airlock/webhook`
const webhookToken = process.env.WEBHOOK_TOKEN ?? ''
const AGENT_ID = process.env.AIRLOCK_AGENT_ID || 'bosun-agent'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- 가짜 Airlock (management API + webhook 발송) ----

type Outcome = 'approved' | 'denied' | 'timeout'
interface Pending {
  req: { id: string; code: string; agentId: string; tool: string; args: Record<string, unknown> }
  settle: (o: Outcome) => void
}
const pending = new Map<string, Pending>()

function askHuman(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<Outcome> {
  const { _airlock, ...rest } = args
  void _airlock
  const req = { id: randomUUID(), code: randomUUID().slice(0, 8).toUpperCase(), agentId: AGENT_ID, tool, args: rest }
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle('timeout'), timeoutMs)
    function settle(o: Outcome) {
      clearTimeout(timer)
      pending.delete(req.id)
      resolve(o)
    }
    pending.set(req.id, { req, settle })
    // 실제 Airlock처럼 잠깐 모았다가 보낸다. 실패해도 다시 보내지 않는다.
    setTimeout(() => {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(webhookToken ? { Authorization: `Bearer ${webhookToken}` } : {}) },
        body: JSON.stringify({ requests: [{ ...req, timeoutMs, badgeCount: pending.size }], text: `Approval needed: ${tool}` }),
      }).catch((err) => console.warn('[fake airlock] webhook failed:', err.message))
    }, 300)
  })
}

const airlockApp = new Hono()
airlockApp.use(async (c, next) => {
  if (c.req.header('Authorization') !== `Bearer ${secret}`) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})
airlockApp.get('/hitl/pending', (c) => c.json([...pending.values()].map((p) => p.req)))
airlockApp.post('/hitl/approve/:id', (c) => {
  const p = pending.get(c.req.param('id'))
  if (!p) return c.json({ error: 'Not found' }, 404)
  p.settle('approved')
  return c.json({ ok: true })
})
airlockApp.post('/hitl/deny/:id', (c) => {
  const p = pending.get(c.req.param('id'))
  if (!p) return c.json({ error: 'Not found' }, 404)
  p.settle('denied')
  return c.json({ ok: true })
})

// ---- 가짜 Docker Agent ----

interface Session {
  id: string
  title: string
  created_at: string
  messages: { agent_name: string; message: { role: string; content: string } }[]
}
const sessions = new Map<string, Session>()

class Run {
  private stream: SSEStreamingApi
  private session: Session
  private reply = ''
  constructor(stream: SSEStreamingApi, session: Session) {
    this.stream = stream
    this.session = session
  }

  async send(ev: Record<string, unknown>) {
    await this.stream.writeSSE({ data: JSON.stringify({ ...ev, agent_name: 'root', timestamp: new Date().toISOString() }) })
  }

  async say(text: string) {
    for (const piece of text.match(/.{1,6}/gsu) ?? []) {
      this.reply += piece
      await this.send({ type: 'agent_choice', content: piece, session_id: this.session.id })
      await sleep(40)
    }
  }

  async init() {
    await this.send({ type: 'stream_started', session_id: this.session.id })
    await this.send({ type: 'mcp_init_started' })
    await sleep(200)
    await this.send({ type: 'mcp_init_finished' })
    await sleep(200)
  }

  // ask면 가짜 Airlock에 승인을 요청하고 결과에 따라 응답한다. 돌려주는 값은 Agent가 받는 도구 결과다.
  async tool(
    name: string,
    args: Record<string, unknown>,
    result: { ask?: boolean; timeoutMs?: number; output?: string; error?: string },
  ): Promise<{ output: string; isError: boolean }> {
    const id = `call_${randomUUID().slice(0, 8)}`
    await this.send({ type: 'tool_call', tool_call: { id, type: 'function', function: { name, arguments: JSON.stringify(args) } } })
    let res = { output: result.output ?? '{}', isError: false }
    if (result.error !== undefined) res = { output: result.error, isError: true }
    else if (result.ask) {
      const outcome = await askHuman(name, args, result.timeoutMs ?? 300_000)
      if (outcome === 'denied') res = { output: 'Request denied by operator', isError: true }
      if (outcome === 'timeout') res = { output: 'Approval timed out. Re-request when operator is available.', isError: true }
    }
    await sleep(300)
    await this.send({
      type: 'tool_call_response',
      tool_call_id: id,
      tool_definition: { name },
      response: res.output,
      result: { output: res.output, ...(res.isError ? { isError: true } : {}) },
    })
    return res
  }

  async stop() {
    this.session.messages.push({ agent_name: 'root', message: { role: 'assistant', content: this.reply } })
    await this.send({ type: 'stream_stopped', session_id: this.session.id })
  }
}

const REASON = { _airlock: { reason: '사용자가 요청한 작업' } }

const SCENARIOS: { match: RegExp; run: (r: Run) => Promise<void> }[] = [
  {
    // 승인 대기가 짧게 끝나는 경우. WEB expiresAt은 30초 - 20초 = 10초 뒤
    match: /만료/,
    run: async (r) => {
      await r.say('nginx-web 컨테이너를 삭제할게요.')
      const res = await r.tool('proxy_delete', { environment_id: 1, method: 'DELETE', path: '/containers/nginx-web', ...REASON }, { ask: true, timeoutMs: 30_000 })
      await r.say(res.isError ? '\n승인되지 않아서 삭제하지 않았어요.' : '\nnginx-web을 삭제했어요.')
    },
  },
  {
    match: /삭제|지워/,
    run: async (r) => {
      await r.say('nginx-web 컨테이너를 삭제할게요.')
      const res = await r.tool('proxy_delete', { environment_id: 1, method: 'DELETE', path: '/containers/nginx-web', ...REASON }, { ask: true })
      await r.say(res.isError ? '\n승인되지 않아서 삭제하지 않았어요.' : '\nnginx-web을 삭제했어요.')
    },
  },
  {
    // exec는 생성·실행 두 번 승인을 받는다(계약 7장).
    match: /명령|exec/,
    run: async (r) => {
      await r.say('web 컨테이너 안에서 ls -al을 실행할게요.')
      const created = await r.tool(
        'proxy_exec',
        { environment_id: 1, method: 'POST', path: '/containers/web/exec', body: { Cmd: ['ls', '-al'], AttachStdout: true }, ...REASON },
        { ask: true, output: '{"Id":"3f9a1c0e"}' },
      )
      if (created.isError) return r.say('\n승인되지 않아서 실행하지 않았어요.')
      const started = await r.tool('proxy_exec', { environment_id: 1, method: 'POST', path: '/exec/3f9a1c0e/start', body: {}, ...REASON }, { ask: true, output: 'total 8\ndrwxr-xr-x 2 root root 4096 .' })
      await r.say(started.isError ? '\n실행은 승인되지 않았어요.' : '\n실행했어요. 파일이 하나 있어요.')
    },
  },
  {
    // arg_policy 위반(하드 차단). isError 결과 본문으로 온다.
    match: /차단|privileged/,
    run: async (r) => {
      await r.tool('proxy_lifecycle', { environment_id: 1, method: 'PATCH', path: '/containers/web/update', ...REASON }, {
        error: 'method "PATCH" is not permitted for proxy_lifecycle. Allowed method: POST. Do not retry with a different value.',
      })
      await r.say('그 작업은 보안 정책상 채팅으로 실행할 수 없어요. 필요하면 Portainer 대시보드에서 직접 해주세요.')
    },
  },
  {
    // 노출 안 된 도구(하드 차단). MCP 오류를 Docker Agent가 감싼 형태
    match: /없는 도구/,
    run: async (r) => {
      await r.tool('proxy_admin', { ...REASON }, {
        error: 'Error calling tool: failed to call tool: calling "tools/call": MCP error -32600: Tool not available: proxy_admin',
      })
      await r.say('그 도구는 쓸 수 없어요.')
    },
  },
  {
    match: /목록|상태|조회/,
    run: async (r) => {
      await r.tool('proxy_read', { environment_id: 1, method: 'GET', path: '/containers/json' }, { output: '[{"Names":["/web"],"State":"running"}]' })
      await r.say('실행 중인 컨테이너는 web 하나예요.')
    },
  },
]

const agentApp = new Hono()

agentApp.post('/api/sessions', async (c) => {
  const body = await c.req.json<{ safety_policy?: string }>().catch(() => ({}) as { safety_policy?: string })
  if (body.safety_policy !== 'restricted') console.warn('[fake agent] session created without safety_policy=restricted')
  const s: Session = { id: randomUUID(), title: '', created_at: new Date().toISOString(), messages: [] }
  sessions.set(s.id, s)
  return c.json({ ...s, safety_policy: body.safety_policy })
})
agentApp.get('/api/sessions', (c) =>
  c.json([...sessions.values()].map((s) => ({ id: s.id, title: s.title, created_at: s.created_at, num_messages: s.messages.length }))),
)
agentApp.get('/api/sessions/:id', (c) => {
  const s = sessions.get(c.req.param('id'))
  return s ? c.json(s) : c.json({ message: 'session not found' }, 404)
})
agentApp.post('/api/sessions/:id/agent/:agent', async (c) => {
  const s = sessions.get(c.req.param('id'))
  if (!s) return c.json({ message: 'session not found' }, 404)
  const { messages } = await c.req.json<{ messages: { content: string }[] }>()
  const text = messages.at(-1)?.content ?? ''
  s.messages.push({ agent_name: '', message: { role: 'user', content: text } })
  if (!s.title) s.title = text.slice(0, 30)

  return streamSSE(c, async (stream) => {
    const r = new Run(stream, s)
    await r.init()
    if (/훅/.test(text)) {
      // 입력 훅이 턴을 멈춘 경우(loop.go emitHookDrivenShutdown)
      await r.send({ type: 'error', error: 'user_prompt_submit hook blocked the request', code: 'hook_blocked' })
      return r.stop()
    }
    if (/오류/.test(text)) {
      await r.send({ type: 'error', error: 'model provider returned 500' })
      return r.stop()
    }
    const scenario = SCENARIOS.find((sc) => sc.match.test(text))
    if (scenario) await scenario.run(r)
    else await r.say(`"${text}"에 대한 가짜 Agent 응답이에요. 키워드: 삭제, 만료, 명령, 차단, 없는 도구, 목록, 훅, 오류`)
    await r.stop()
  })
})

serve({ fetch: agentApp.fetch, hostname: '127.0.0.1', port: agentPort }, () =>
  console.info(`[fake agent] http://127.0.0.1:${agentPort}`),
)
serve({ fetch: airlockApp.fetch, hostname: '127.0.0.1', port: airlockPort }, () =>
  console.info(`[fake airlock] http://127.0.0.1:${airlockPort} → webhook ${webhookUrl}`),
)
