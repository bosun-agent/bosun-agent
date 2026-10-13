// 개발용 가짜 Docker Agent. LLM이나 Portainer 없이 WEB 백엔드 흐름을 끝까지 돌려 보려고 쓴다.
// 이벤트·응답 모양은 실제 소스(docker-agent v1.145.0 pkg/runtime/event.go, pkg/runtime/toolexec)를 따른다.
// 실행: npm run server:fake → 메시지 내용의 키워드로 시나리오를 고른다(아래 SCENARIOS).

import { randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'

const agentPort = Number(new URL(process.env.AGENT_URL ?? 'http://127.0.0.1:8080').port)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Session {
  id: string
  title: string
  created_at: string
  messages: { agent_name: string; message: { role: string; content: string } }[]
  // 실행 요청에 model이 오면 기억한다. 진짜 Docker Agent도 대화에 저장한다. 스모크 테스트가 읽는다.
  model?: string
}
const sessions = new Map<string, Session>()

interface Resume {
  confirmation: string
  reason?: string
}

class Run {
  private stream: SSEStreamingApi
  private session: Session
  private reply = ''
  // 승인을 기다리는 중이면 결정을 넘겨받을 함수. 진짜처럼 기다리는 건이 없으면 resume을 버린다.
  waiting: ((r: Resume) => void) | null = null
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

  private respond(id: string, name: string, output: string, isError: boolean) {
    return this.send({
      type: 'tool_call_response',
      tool_call_id: id,
      tool_definition: { name },
      response: output,
      result: { output, ...(isError ? { isError: true } : {}) },
    })
  }

  // 진짜 Docker Agent 순서(toolexec dispatcher): 승인이 필요하면 tool_call_confirmation을 보내고 /resume을 기다린다.
  // 승인되거나 승인이 필요 없으면 그때 tool_call을 보내고 실행한다. 막히면 tool_call 없이 오류 결과만 보낸다.
  // 돌려주는 값은 모델이 받는 도구 결과다.
  async tool(
    name: string,
    args: Record<string, unknown>,
    result: { ask?: boolean; output?: string; deny?: string; hookBlock?: string },
  ): Promise<{ output: string; isError: boolean }> {
    const call = { id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }

    if (result.deny !== undefined) {
      await this.respond(call.id, name, result.deny, true)
      return { output: result.deny, isError: true }
    }
    if (result.hookBlock !== undefined) {
      const message = `The tool call was rejected by a tool_guard hook. Reason: ${result.hookBlock}`
      await this.send({ type: 'hook_blocked', tool_call: call, tool_definition: { name }, message })
      await this.respond(call.id, name, message, true)
      return { output: message, isError: true }
    }
    if (result.ask) {
      await this.send({ type: 'tool_call_confirmation', tool_call: call, tool_definition: { name } })
      const decision = await new Promise<Resume>((r) => (this.waiting = r))
      this.waiting = null
      if (decision.confirmation !== 'approve') {
        const reason = decision.reason?.trim()
        const output = `The user rejected the tool call.${reason ? ` Reason: ${reason}` : ''}`
        await this.respond(call.id, name, output, true)
        return { output, isError: true }
      }
    }
    await this.send({ type: 'tool_call', tool_call: call })
    await sleep(300)
    const output = result.output ?? '{}'
    await this.respond(call.id, name, output, false)
    return { output, isError: false }
  }

  async stop() {
    this.session.messages.push({ agent_name: 'root', message: { role: 'assistant', content: this.reply } })
    await this.send({ type: 'stream_stopped', session_id: this.session.id })
  }
}

// 세션 ID → 진행 중인 실행. resume이 여기로 결정을 넘긴다.
const runs = new Map<string, Run>()

const SCENARIOS: { match: RegExp; run: (r: Run) => Promise<void> }[] = [
  {
    match: /삭제|지워|만료/,
    run: async (r) => {
      await r.say('nginx-web 컨테이너를 삭제할게요.')
      const res = await r.tool('docker_proxy', { environment_id: 1, method: 'DELETE', path: '/containers/nginx-web' }, { ask: true })
      await r.say(res.isError ? '\n승인되지 않아서 삭제하지 않았어요.' : '\nnginx-web을 삭제했어요.')
    },
  },
  {
    // 모델이 조회로 ID를 알아낸 뒤 ID로 지우는 경우. force·v 옵션이 쿼리로 온다(2026-10-11 실측).
    match: /강제/,
    run: async (r) => {
      const id = 'dda78131504e8da3ad211252f7b32a752ed69d0ff2c512057904ee026d7761a9'
      await r.tool('docker_proxy', { environment_id: 1, method: 'GET', path: '/containers/json', select: '[].{id:Id,name:Names[0]}' }, {
        output: JSON.stringify([{ id, name: '/my-website' }]),
      })
      const res = await r.tool(
        'docker_proxy',
        { environment_id: 1, method: 'DELETE', path: `/containers/${id}`, query_params: { force: 'true', v: 'true' } },
        { ask: true, output: '' },
      )
      await r.say(res.isError ? '승인되지 않아서 지우지 않았어요.' : '지웠어요.')
    },
  },
  {
    // 생성할 때 Cmd로 셸 명령을 넣는 경우(2026-10-11 실제 모델이 이렇게 했다). 카드에 명령이 보여야 한다.
    match: /웹사이트/,
    run: async (r) => {
      await r.say('nginx로 웹사이트 컨테이너를 만들게요.')
      const res = await r.tool(
        'docker_proxy',
        {
          environment_id: 1,
          method: 'POST',
          path: '/containers/create',
          query_params: { name: 'my-website' },
          body: {
            Image: 'nginx:alpine',
            Cmd: ['/bin/sh', '-c', "echo hi > /usr/share/nginx/html/index.html && exec nginx -g 'daemon off;'"],
            HostConfig: { PortBindings: { '80/tcp': [{ HostPort: '8090' }] } },
          },
        },
        { ask: true, output: '{"Id":"dda78131"}' },
      )
      await r.say(res.isError ? '승인되지 않아서 만들지 않았어요.' : 'my-website를 만들었어요.')
    },
  },
  {
    // 만들고 바로 시작하는 경우. 생성 결과에는 ID만 와서, 모델은 시작을 ID로 부른다(2026-10-13 실측).
    match: /만들고 시작/,
    run: async (r) => {
      const id = '506f862aab4b2d8a81f2ed7a3ca5920dda541f77eb4eebf36366026d8f11919f'
      const made = await r.tool(
        'docker_proxy',
        { environment_id: 1, method: 'POST', path: '/containers/create', query_params: { name: 'bosun-test-web' }, body: { Image: 'nginx:alpine' } },
        { ask: true, output: JSON.stringify({ id, warnings: [] }) },
      )
      if (made.isError) return r.say('승인되지 않아서 만들지 않았어요.')
      const res = await r.tool('docker_proxy', { environment_id: 1, method: 'POST', path: `/containers/${id}/start` }, { ask: true, output: '' })
      await r.say(res.isError ? '승인되지 않아서 시작하지 않았어요.' : '시작했어요.')
    },
  },
  {
    // 상태 변경(POST)은 승인을 받는다. GET은 permissions.allow라 묻지 않는다.
    match: /재시작|중지/,
    run: async (r) => {
      await r.say('web 컨테이너를 재시작할게요.')
      const res = await r.tool('docker_proxy', { environment_id: 1, method: 'POST', path: '/containers/web/restart' }, { ask: true, output: '' })
      await r.say(res.isError ? '\n승인되지 않아서 재시작하지 않았어요.' : '\nweb을 재시작했어요.')
    },
  },
  {
    // tool_guard 훅 거부(Secure 검사). hook_blocked 이벤트와 오류 결과가 온다.
    match: /차단|privileged/,
    run: async (r) => {
      await r.tool('docker_proxy', { environment_id: 1, method: 'POST', path: '/containers/create', body: { HostConfig: { Privileged: true } } }, {
        hookBlock: 'privileged containers are not allowed',
      })
      await r.say('그 작업은 보안 정책상 채팅으로 실행할 수 없어요. 필요하면 Portainer 대시보드에서 직접 해주세요.')
    },
  },
  {
    // agent.yaml permissions.deny(exec, archive, export, prune, 볼륨 삭제)
    match: /금지|명령|exec/,
    run: async (r) => {
      await r.tool(
        'docker_proxy',
        { environment_id: 1, method: 'POST', path: '/containers/web/exec', body: { Cmd: ['ls', '-al'] } },
        { deny: "Tool 'docker_proxy' is denied by permissions configuration." },
      )
      await r.say('컨테이너 안 명령 실행은 정책상 할 수 없어요.')
    },
  },
  {
    // 모델이 없는 도구를 부른 경우. 정책 차단이 아니라 모델 실수라서 실패로만 보인다.
    match: /없는 도구/,
    run: async (r) => {
      await r.tool('ContainerList', {}, { deny: "Tool 'ContainerList' is not available. You can only use the tools provided to you." })
      await r.say('그 도구는 없어요.')
    },
  },
  {
    match: /목록|상태|조회/,
    run: async (r) => {
      await r.tool('docker_proxy', { environment_id: 1, method: 'GET', path: '/containers/json' }, { output: '[{"Names":["/web"],"State":"running"}]' })
      await r.say('실행 중인 컨테이너는 web 하나예요.')
    },
  },
]

const agentApp = new Hono()

agentApp.post('/api/sessions', async (c) => {
  const body = await c.req.json<{ safety_policy?: string }>().catch(() => ({}) as { safety_policy?: string })
  // 정책은 agent.yaml에서 정한다. WEB이 세션마다 안전 모드를 덮어쓰면 안 된다(계약 6장).
  if (body.safety_policy) console.warn(`[fake agent] session created with safety_policy=${body.safety_policy}`)
  const s: Session = { id: randomUUID(), title: '', created_at: new Date().toISOString(), messages: [] }
  sessions.set(s.id, s)
  return c.json(s)
})
agentApp.get('/api/sessions', (c) =>
  c.json([...sessions.values()].map((s) => ({ id: s.id, title: s.title, created_at: s.created_at, num_messages: s.messages.length }))),
)
agentApp.get('/api/sessions/:id', (c) => {
  const s = sessions.get(c.req.param('id'))
  return s ? c.json(s) : c.json({ message: 'session not found' }, 404)
})
agentApp.delete('/api/sessions/:id', (c) => {
  if (!sessions.delete(c.req.param('id'))) return c.json({ message: 'session not found' }, 404)
  return c.json({ message: 'session deleted' })
})
agentApp.patch('/api/sessions/:id/title', async (c) => {
  const s = sessions.get(c.req.param('id'))
  if (!s) return c.json({ message: 'session not found' }, 404)
  s.title = (await c.req.json<{ title: string }>()).title
  return c.json({ id: s.id, title: s.title })
})
agentApp.post('/api/sessions/:id/resume', async (c) => {
  const run = runs.get(c.req.param('id'))
  // 진짜 Docker Agent는 실행 중이 아니면 500을 준다(session_manager.go ResumeSession).
  if (!run) return c.json({ message: 'failed to resume session: session not running' }, 500)
  const body = await c.req.json<Resume>()
  if (!['approve', 'reject'].includes(body.confirmation)) {
    // WEB은 approve·reject만 보내야 한다. 나머지는 세션 권한을 넓힌다(계약 5장).
    console.warn(`[fake agent] unexpected confirmation ${body.confirmation}`)
  }
  run.waiting?.(body)
  return c.json({ message: 'session resumed' })
})
agentApp.post('/api/sessions/:id/agent/:agent', async (c) => {
  const s = sessions.get(c.req.param('id'))
  if (!s) return c.json({ message: 'session not found' }, 404)
  const { messages, model } = await c.req.json<{ messages: { content: string }[]; model?: string }>()
  const text = messages.at(-1)?.content ?? ''
  if (model) s.model = model
  s.messages.push({ agent_name: '', message: { role: 'user', content: text } })
  if (!s.title) s.title = text.slice(0, 30)

  // 키가 없으면 Docker Agent는 스트림을 열기 전에 500으로 거절한다(실측 2026-10-05, v1.145.0).
  if (/키 없음/.test(text)) {
    return c.json({ message: 'failed to run session: load "agent": The following environment variables must be set:\n - OPENROUTER_API_KEY\n' }, 500)
  }

  return streamSSE(c, async (stream) => {
    const r = new Run(stream, s)
    runs.set(s.id, r)
    // 진짜처럼 클라이언트가 끊으면 실행을 취소한다. 기다리던 승인도 취소로 끝난다.
    stream.onAbort(() => {
      runs.delete(s.id)
      r.waiting?.({ confirmation: 'reject', reason: 'canceled' })
    })
    try {
      await r.init()
      if (/훅/.test(text)) {
        // 입력 훅이 턴을 멈춘 경우(loop.go emitHookDrivenShutdown)
        await r.send({ type: 'error', error: 'user_prompt_submit hook blocked the request', code: 'hook_blocked' })
        return await r.stop()
      }
      if (/키 오류/.test(text)) {
        // 키가 틀리면 모델 호출에서 실패한다(실측 2026-10-05, OpenRouter).
        await r.send({ type: 'error', error: 'model failed: error receiving from stream: HTTP 401: User not found.', code: 'model_error' })
        return await r.stop()
      }
      if (/오류/.test(text)) {
        await r.send({ type: 'error', error: 'model provider returned 500' })
        return await r.stop()
      }
      if (/반복/.test(text)) {
        // max_iterations에 닿으면 계속할지 묻고 기다린다(loop_steps.go). reject면 멈춘다.
        await r.send({ type: 'max_iterations_reached', max_iterations: 10 })
        const decision = await new Promise<Resume>((res) => (r.waiting = res))
        r.waiting = null
        await r.say(decision.confirmation === 'approve' ? '계속할게요.' : 'Execution stopped after reaching the configured max_iterations limit (10).')
        return await r.stop()
      }
      const scenario = SCENARIOS.find((sc) => sc.match.test(text))
      if (scenario) await scenario.run(r)
      else await r.say(`"${text}"에 대한 가짜 Agent 응답이에요. 키워드: 삭제, 강제, 만료, 웹사이트, 재시작, 명령, 차단, 금지, 없는 도구, 목록, 훅, 오류, 반복, 키 없음, 키 오류`)
      await r.stop()
    } finally {
      if (runs.get(s.id) === r) runs.delete(s.id)
    }
  })
})

serve({ fetch: agentApp.fetch, hostname: '127.0.0.1', port: agentPort }, () =>
  console.info(`[fake agent] http://127.0.0.1:${agentPort}`),
)
