// 가짜 Agent를 띄운 상태에서 WEB 백엔드 흐름을 확인하는 스모크 테스트.
// 실행: npm run server:fake, npm run server를 띄운 뒤 npm run server:smoke

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname } from 'node:path'
import type { AgentEvent } from '../../src/lib/agentProtocol.ts'
import { readSSE } from '../../src/lib/sse.ts'

const BASE = `http://127.0.0.1:${process.env.PORT ?? 3001}`
let failures = 0

function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++
  console.info(`${ok ? 'ok  ' : 'FAIL'} ${name}`, ok ? '' : JSON.stringify(detail))
}

// ---- 이 PC에서만(server/guard.ts) ----
// 아래 요청은 모두 X-Bosun 헤더를 붙여 보낸다. 브라우저 화면(httpAgent)과 같다.
const rawFetch = globalThis.fetch
globalThis.fetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
  if (!String(input).startsWith(BASE)) return rawFetch(input, init)
  const headers = new Headers(init.headers)
  headers.set('X-Bosun', '1')
  return rawFetch(input, { ...init, headers })
}
// fetch로는 Host를 바꿀 수 없어서 node:http로 보낸다.
function rawRequest(method: string, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${BASE}${path}`, { method, headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}
{
  const list = await fetch(`${BASE}/api/sessions`)
  check('로그인 없이 /api를 부른다', list.status === 200, list.status)
  const noHeader = await rawFetch(`${BASE}/api/sessions`, { method: 'POST' })
  check('X-Bosun 헤더 없는 POST는 403', noHeader.status === 403, noHeader.status)
  const rebind = await rawRequest('GET', '/api/sessions', { Host: 'evil.example:3001' })
  const lan = await rawRequest('GET', '/api/sessions', { Host: '192.168.0.10:3001' })
  const vite = await rawRequest('GET', '/api/sessions', { Host: 'localhost:5173' })
  const v6 = await rawRequest('GET', '/api/sessions', { Host: '[::1]:3001' })
  check('Host가 루프백이 아니면 403(DNS 리바인딩)', rebind === 403 && lan === 403 && vite === 200 && v6 === 200, [rebind, lan, vite, v6])
  const cross = await rawRequest('POST', '/api/sessions', { 'X-Bosun': '1', Origin: 'https://evil.example' })
  const nullOrigin = await rawRequest('POST', '/api/sessions', { 'X-Bosun': '1', Origin: 'null' })
  const same = await rawRequest('POST', '/api/sessions', { 'X-Bosun': '1', Origin: 'http://localhost:5173' })
  check('Origin이 루프백이 아니면 403', cross === 403 && nullOrigin === 403 && same === 201, [cross, nullOrigin, same])
  const gone = await fetch(`${BASE}/api/auth/me`)
  check('로그인 엔드포인트는 없다', gone.status === 404, gone.status)
}

// ---- Agent 관리(server/agentProcess.ts). AGENT_BIN이 없으면 붙기만 한다. 관리 흐름은 npm run test:agent ----
{
  const s = (await (await fetch(`${BASE}/api/agent`)).json()) as { managed: boolean; state: string; reachable?: boolean }
  const restart = (await (await fetch(`${BASE}/api/agent/restart`, { method: 'POST' })).json()) as { restart: string }
  check('AGENT_BIN이 없으면 관리 안 함(off), 다시 시작은 manual', !s.managed && s.state === 'off' && s.reachable === true && restart.restart === 'manual', [s, restart])
}

async function post(path: string, body: unknown): Promise<{ status: number; events: AgentEvent[]; json?: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) {
    return { status: res.status, events: [], json: await res.json() }
  }
  const events: AgentEvent[] = []
  for await (const ev of readSSE(res.body!)) events.push(ev as AgentEvent)
  return { status: res.status, events }
}

const types = (events: AgentEvent[]) => events.map((e) => e.type)
const last = (events: AgentEvent[]) => events.at(-1)?.type
const text = (events: AgentEvent[]) => events.map((e) => (e.type === 'text_delta' ? e.delta : '')).join('')
const approvalOf = (events: AgentEvent[]) =>
  events.find((e): e is Extract<AgentEvent, { type: 'approval_required' }> => e.type === 'approval_required')

async function newSession(): Promise<string> {
  const res = await fetch(`${BASE}/api/sessions`, { method: 'POST' })
  return ((await res.json()) as { sessionId: string }).sessionId
}

const sid = await newSession()
const send = (text: string) => post(`/api/sessions/${sid}/messages`, { text })
const decide = (approvalId: string, decision: string, reason?: string) =>
  post(`/api/sessions/${sid}/approvals/${approvalId}`, { decision, ...(reason ? { reason } : {}) })

{
  const r = await send('안녕')
  check('일반 응답은 done으로 끝난다', last(r.events) === 'done', types(r.events))
}
{
  const r = await send('컨테이너 목록 보여줘')
  const tools = r.events.filter((e) => e.type === 'tool_status')
  check('조회는 tool_status running → succeeded', tools.length === 2 && JSON.stringify(tools).includes('조회 완료'), tools)
  check('tool_status에 인자가 없다', !JSON.stringify(r.events).includes('/containers/json'), r.events)
}
{
  const r = await send('삭제해줘')
  const ap = approvalOf(r.events)
  check('삭제는 approval_required로 끝난다', last(r.events) === 'approval_required', types(r.events))
  check('승인 카드 문구', ap?.summary === '컨테이너 nginx-web 삭제' && ap.action.target === 'nginx-web', ap)
  check('삭제 카드 위험도는 되돌릴 수 없음', ap?.risk?.level === 'high' && ap.risk.label === '되돌릴 수 없음', ap?.risk)
  const busy = await send('목록')
  check('승인 대기 중 새 메시지는 409', busy.status === 409, busy)
  const del = await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' })
  check('승인 대기 중인 대화는 지울 수 없다(409)', del.status === 409, del.status)
  const d = await decide(ap!.approvalId, 'approve')
  check('승인 뒤 스트림이 이어지고 done', last(d.events) === 'done' && text(d.events).includes('삭제했어요'), types(d.events))
  const again = await decide(ap!.approvalId, 'approve')
  check('같은 승인 다시 보내면 409', again.status === 409, again)
  const other = await post(`/api/sessions/nope/approvals/${ap!.approvalId}`, { decision: 'approve' })
  check('다른 세션의 승인은 404', other.status === 404, other)
}
{
  const r = await send('지워줘')
  const ap = approvalOf(r.events)
  const d = await decide(ap!.approvalId, 'deny')
  check('거부 뒤 Agent 설명이 이어진다', last(d.events) === 'done' && text(d.events).includes('승인되지 않아서'), types(d.events))
  check('사용자 거부는 차단 카드나 실패 줄을 만들지 않는다', !types(d.events).includes('rejected') && !types(d.events).includes('tool_status'), types(d.events))
}
{
  const r = await send('web 재시작해줘')
  const ap = approvalOf(r.events)
  check('재시작 카드 문구', ap?.summary === '컨테이너 web 재시작' && JSON.stringify(ap.action.params).includes('POST /containers/web/restart'), ap)
  check('재시작 카드 위험도는 잠깐 끊김', ap?.risk?.level === 'medium' && ap.risk.label === '잠깐 끊김', ap?.risk)
  const d = await decide(ap!.approvalId, 'approve')
  const tools = d.events.filter((e) => e.type === 'tool_status')
  check('승인 뒤 처리 과정에 작업 이름이 보인다', JSON.stringify(tools).includes('재시작 완료'), tools)
}
{
  const r = await send('my-website 강제 제거해줘')
  const ap = approvalOf(r.events)
  check(
    'ID로 지우면 카드에 이름과 force·v 경고가 보인다',
    ap?.summary === '컨테이너 my-website 삭제' && ap.action.target === 'my-website (dda78131504e)' &&
      String(ap.action.params?.옵션).includes('force=true') &&
      ['FORCE', 'VOLUMES'].every((c) => ap.reasons.some((x) => x.code === c)),
    ap,
  )
  await decide(ap!.approvalId, 'deny')
}
{
  const r = await send('웹사이트 만들어줘')
  const ap = approvalOf(r.events)
  const params = ap?.action.params ?? {}
  check(
    '생성 카드에 이미지·명령·포트와 명령 경고가 보인다',
    params.이미지 === 'nginx:alpine' && String(params.명령).includes('index.html') && params.포트 === '8090 → 80/tcp' &&
      ap!.reasons.some((x) => x.code === 'COMMAND'),
    ap,
  )
  check(
    '생성 카드는 새로 만듦, 명령 경고에 판단 기준이 있다',
    ap?.risk?.level === 'low' && ap.reasons.some((x) => x.code === 'COMMAND' && x.message.includes('기본 명령')),
    ap,
  )
  const d = await decide(ap!.approvalId, 'deny')
  // 도구 호출 앞뒤 문장이 붙지 않게 빈 줄이 들어간다.
  check('도구 호출 뒤 문장은 빈 줄로 나뉜다', text(d.events).startsWith('\n\n승인되지 않아서'), text(d.events))
}
{
  const r = await send('컨테이너 만들고 시작해줘')
  const made = await decide(approvalOf(r.events)!.approvalId, 'approve')
  const start = approvalOf(made.events)
  check('생성 직후 시작 카드는 ID 대신 요청한 이름을 보여준다', start?.summary === '컨테이너 bosun-test-web 시작', start)
  await decide(start!.approvalId, 'deny')
}
{
  const r = await send('명령 실행해줘')
  check('exec는 승인 카드 없이 rejected', types(r.events).includes('rejected') && !types(r.events).includes('approval_required'), types(r.events))
}
{
  const r = await send('차단되는 작업')
  check('tool_guard 거부는 rejected + done', types(r.events).includes('rejected') && last(r.events) === 'done', types(r.events))
  const rej = r.events.find((e) => e.type === 'rejected')
  check('훅 거부 사유가 detail로 온다', rej?.type === 'rejected' && rej.detail === 'privileged containers are not allowed', rej)
}
{
  const r = await send('금지된 도구 써줘')
  const rej = r.events.find((e) => e.type === 'rejected')
  check('permissions.deny는 rejected(사유 없음)', rej?.type === 'rejected' && rej.detail === undefined, rej)
}
{
  const r = await send('없는 도구 써줘')
  check('모델이 없는 도구를 부르면 실패 줄만', !types(r.events).includes('rejected') && types(r.events).includes('tool_status'), types(r.events))
}
{
  const r = await send('훅 테스트')
  const rej = r.events.find((e) => e.type === 'rejected')
  check('훅 차단은 HOOK_BLOCKED + done', JSON.stringify(rej).includes('HOOK_BLOCKED') && last(r.events) === 'done', types(r.events))
}
{
  const r = await send('오류 내줘')
  check('Agent 오류는 error로 끝나고 done이 없다', last(r.events) === 'error' && !types(r.events).includes('done'), types(r.events))
}
{
  const r = await send('반복 한도')
  check('max_iterations에 닿으면 WEB이 멈추게 하고 done', last(r.events) === 'done' && text(r.events).includes('stopped'), types(r.events))
}
{
  const res = await fetch(`${BASE}/api/sessions/${sid}/messages`)
  const { messages } = (await res.json()) as { messages: { role: string; content: string; cards?: unknown[] }[] }
  const withCards = messages.filter((m) => m.cards?.length)
  check('대화 복원에 사용자 메시지가 모두 있다', messages.filter((m) => m.role === 'user').length === 15, messages.length)
  check('대화 복원에 승인·차단 카드가 붙는다', withCards.length === 10, withCards)
}
{
  // 생성 body가 빠져 두 번 막힌 뒤 다시 만드는 경우(2026-10-28 리허설). 다른 대화에서 해서 위 개수에 섞이지 않게 한다.
  const s = await newSession()
  const r = await post(`/api/sessions/${s}/messages`, { text: '설정 없이 만들어줘' })
  const rejs = r.events.filter((e) => e.type === 'rejected')
  check(
    '정책 훅 사유는 앞머리와 허용 범위를 빼고 첫 문장만',
    rejs.length === 2 && rejs.every((e) => e.type === 'rejected' && e.detail === '컨테이너 생성 body(설정)가 없습니다'),
    rejs,
  )
  const ap = approvalOf(r.events)
  const d = await post(`/api/sessions/${s}/approvals/${ap!.approvalId}`, { decision: 'approve' })
  check('막힌 뒤 다시 만든 생성은 승인되고 done', last(d.events) === 'done', types(d.events))
  const { messages } = (await fetch(`${BASE}/api/sessions/${s}/messages`).then((res) => res.json())) as {
    messages: { cards?: { kind: string; detail?: string; status?: string }[] }[]
  }
  const cards = messages.flatMap((m) => m.cards ?? [])
  check(
    '복원 카드에 차단 사유가 남고 순서가 차단 → 승인',
    cards.map((c) => (c.kind === 'rejected' ? c.detail : c.status)).join('|') === '컨테이너 생성 body(설정)가 없습니다|컨테이너 생성 body(설정)가 없습니다|approved',
    cards,
  )
}
{
  const r = await send('만료 테스트')
  const ap = approvalOf(r.events)
  const timeout = Number(process.env.APPROVAL_TIMEOUT_MS || 300_000)
  const wait = new Date(ap!.expiresAt).getTime() - Date.now()
  check('만료 시각은 카드를 띄운 때 + APPROVAL_TIMEOUT_MS', wait > timeout - 5_000 && wait <= timeout + 1_000, wait)
  // 만료까지 기다리지 않고 브라우저가 보내는 만료 거부를 흉내 낸다.
  const d = await decide(ap!.approvalId, 'deny', 'expired')
  check('만료 거부 뒤 Agent 설명이 이어진다', last(d.events) === 'done' && text(d.events).includes('승인되지 않아서'), types(d.events))
  const { messages } = (await fetch(`${BASE}/api/sessions/${sid}/messages`).then((res) => res.json())) as {
    messages: { cards?: { kind: string; approvalId?: string; status?: string }[] }[]
  }
  const card = messages.flatMap((m) => m.cards ?? []).find((c) => c.approvalId === ap!.approvalId)
  check('만료 카드는 expired로 복원된다', card?.status === 'expired', card)
}

{
  const s3 = await newSession()
  const noKey = await post(`/api/sessions/${s3}/messages`, { text: '키 없음' })
  check('키가 없으면 NO_API_KEY', (noKey.json as { error?: string })?.error === 'NO_API_KEY', noKey)
  const badKey = await post(`/api/sessions/${s3}/messages`, { text: '키 오류' })
  const err = badKey.events.at(-1)
  check('키가 틀리면 INVALID_API_KEY', err?.type === 'error' && err.code === 'INVALID_API_KEY', badKey.events)
}

// ---- 리허설(2026-10-28)에서 나온 경우 ----
{
  const sx = await newSession()
  const empty = await post(`/api/sessions/${sx}/messages`, { text: '빈 답 테스트' })
  const endEmpty = empty.events.at(-1)
  check('모델이 아무것도 내지 않고 끝나면 EMPTY_REPLY 오류', endEmpty?.type === 'error' && endEmpty.code === 'EMPTY_REPLY' && !types(empty.events).includes('done'), types(empty.events))
  const loop = await post(`/api/sessions/${sx}/messages`, { text: '같은 호출 되풀이' })
  const endLoop = loop.events.at(-1)
  check('같은 호출을 되풀이해 Agent가 끊으면 LOOP_DETECTED 안내', endLoop?.type === 'error' && endLoop.code === 'LOOP_DETECTED' && endLoop.message.includes('바꿔서'), loop.events)
  const leaked = await post(`/api/sessions/${sx}/messages`, { text: '도구 표기 테스트' })
  const endLeak = leaked.events.at(-1)
  check(
    '도구 호출 표기를 글로 보내면 표기는 숨기고 TOOL_CALL_AS_TEXT 오류',
    text(leaked.events).includes("I'll first check") && !text(leaked.events).includes('DSML') && !text(leaked.events).includes('<') &&
      endLeak?.type === 'error' && endLeak.code === 'TOOL_CALL_AS_TEXT',
    leaked.events,
  )
  const lt = await post(`/api/sessions/${sx}/messages`, { text: '목록 보여줘' })
  check('표기 뒤 다음 턴은 정상', last(lt.events) === 'done' && text(lt.events).includes('web 하나'), types(lt.events))
  const unknown = await post(`/api/sessions/${sx}/messages`, { text: '모르는 도구 써줘' })
  const ap = approvalOf(unknown.events)
  check(
    '모르는 도구 카드: 확인할 수 없다고 하고 인자는 이름만',
    ap?.summary === '어떤 작업인지 확인할 수 없어요.' && ap.risk?.level === 'unknown' && ap.reasons.some((x) => x.code === 'UNKNOWN') &&
      String(ap.action.params?.인자).includes('encryptionKey') && !JSON.stringify(ap).includes('super-secret-value'),
    ap,
  )
  await post(`/api/sessions/${sx}/approvals/${ap!.approvalId}`, { decision: 'deny' })
}
{
  const put = (model: string) =>
    fetch(`${BASE}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) })
  const bad = await put('openrouter/unknown/model')
  check('목록에 없는 모델은 400', bad.status === 400, bad.status)
  const settings = (await fetch(`${BASE}/api/settings`).then((r) => r.json())) as { models: string[]; portainerUrl?: string }
  check('설정에 차단 안내용 Portainer 주소(dev.env PORTAINER_URL)', settings.portainerUrl === 'https://localhost:9443', settings.portainerUrl)
  const chosen = settings.models.at(-1)!
  const ok = await put(chosen)
  check('모델을 고르면 저장된다', ok.status === 200 && ((await ok.json()) as { model: string }).model === chosen, chosen)
  const s2 = await newSession()
  await post(`/api/sessions/${s2}/messages`, { text: '안녕' })
  const upstream = (await fetch(`${process.env.AGENT_URL}/api/sessions/${s2}`).then((r) => r.json())) as { model?: string }
  check('고른 모델이 Agent 실행 요청에 실린다', upstream.model === chosen, upstream.model)
  await put(settings.models[0])
}

{
  // 키 저장은 Agent env 파일의 키 줄만 바꾸고 Portainer 줄은 남긴다.
  const file = process.env.AGENT_ENV_FILE!
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '# agent env\nPORTAINER_URL=https://127.0.0.1:9443\nOPENROUTER_API_KEY=old-key-0000\n')
  const put = (apiKey: string) =>
    fetch(`${BASE}/api/settings/api-key`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }) })
  const bad = await put('bad key\nX=1')
  check('줄바꿈이 든 키는 400', bad.status === 400, bad.status)
  const ok = await put('sk-test-12345678')
  const body = await ok.text()
  check('키를 저장하면 set: true, 키 값은 돌려주지 않는다', ok.status === 200 && body.includes('"set":true') && !body.includes('sk-test'), body)
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  check(
    'env 파일에서 키 줄만 바뀐다',
    JSON.stringify(lines) === JSON.stringify(['# agent env', 'PORTAINER_URL=https://127.0.0.1:9443', 'OPENROUTER_API_KEY=sk-test-12345678']),
    lines,
  )
}

{
  const s4 = await newSession()
  await post(`/api/sessions/${s4}/messages`, { text: '지울 대화' })
  const del = await fetch(`${BASE}/api/sessions/${s4}`, { method: 'DELETE' })
  const list = (await fetch(`${BASE}/api/sessions`).then((r) => r.json())) as { sessions: { sessionId: string }[] }
  const gone = await fetch(`${BASE}/api/sessions/${s4}/messages`)
  check(
    '대화를 지우면 목록과 복원에서 사라진다',
    del.status === 204 && !list.sessions.some((s) => s.sessionId === s4) && gone.status === 404,
    { del: del.status, gone: gone.status },
  )
}
// ---- 대화별 동시 처리, 다시 붙기, 중지 ----

// 응답을 n개 이벤트만 읽고 끊는다(새로고침한 브라우저처럼).
async function readSome(path: string, body: unknown, n: number): Promise<AgentEvent[]> {
  const ctrl = new AbortController()
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  })
  const events: AgentEvent[] = []
  try {
    for await (const ev of readSSE(res.body!)) {
      events.push(ev as AgentEvent)
      if (events.length >= n) break
    }
  } finally {
    ctrl.abort()
  }
  return events
}

async function stream(sessionId: string): Promise<{ status: number; events: AgentEvent[] }> {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/stream`)
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return { status: res.status, events: [] }
  const events: AgentEvent[] = []
  for await (const ev of readSSE(res.body!)) events.push(ev as AgentEvent)
  return { status: res.status, events }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

{
  const [a, b, c2, d] = [await newSession(), await newSession(), await newSession(), await newSession()]
  const ra = await post(`/api/sessions/${a}/messages`, { text: '삭제해줘' })
  const rb = await post(`/api/sessions/${b}/messages`, { text: 'web 재시작해줘' })
  check('다른 대화는 승인 대기 중에도 보낼 수 있다', last(ra.events) === 'approval_required' && last(rb.events) === 'approval_required', [
    types(ra.events),
    types(rb.events),
  ])
  const same = await post(`/api/sessions/${a}/messages`, { text: '목록' })
  check('같은 대화는 처리 중이면 409 BUSY', same.status === 409 && (same.json as { error: string }).error === 'BUSY', same)
  const rc = await post(`/api/sessions/${c2}/messages`, { text: '지워줘' })
  const rd = await post(`/api/sessions/${d}/messages`, { text: '안녕' })
  check('동시 처리는 MAX_TURNS(3)까지, 넘으면 409 TOO_MANY', last(rc.events) === 'approval_required' && (rd.json as { error?: string })?.error === 'TOO_MANY', rd)
  // a와 c2는 둘 다 nginx-web을 지우려 한다. 나중 카드에만 경고가 붙는다.
  check(
    '다른 대화가 같은 대상을 기다리면 새 카드에 CONCURRENT 경고',
    approvalOf(rc.events)?.reasons.some((x) => x.code === 'CONCURRENT') === true && !approvalOf(ra.events)?.reasons.some((x) => x.code === 'CONCURRENT') &&
      !approvalOf(rb.events)?.reasons.some((x) => x.code === 'CONCURRENT'),
    [approvalOf(ra.events)?.reasons, approvalOf(rc.events)?.reasons],
  )

  const list = (await fetch(`${BASE}/api/sessions`).then((r) => r.json())) as { sessions: { sessionId: string; running?: boolean }[] }
  check('대화 목록에 처리 중 표시', [a, b, c2].every((id) => list.sessions.find((s) => s.sessionId === id)?.running) && !list.sessions.find((s) => s.sessionId === d)?.running, list)

  const restored = (await fetch(`${BASE}/api/sessions/${a}/messages`).then((r) => r.json())) as { messages: { role: string; cards?: unknown[] }[]; running?: boolean }
  check('처리 중인 대화 복원은 running이고 그 턴의 답·카드를 뺀다', restored.running === true && restored.messages.length === 1 && restored.messages[0].role === 'user', restored)

  const again = await stream(a)
  check(
    '다시 붙으면 이 턴의 이벤트를 처음부터 받고 승인 카드에서 끝난다',
    text(again.events).includes('삭제할게요') && last(again.events) === 'approval_required' && approvalOf(again.events)?.approvalId === approvalOf(ra.events)?.approvalId,
    types(again.events),
  )
  const da = await post(`/api/sessions/${a}/approvals/${approvalOf(ra.events)!.approvalId}`, { decision: 'deny' })
  check('다시 붙은 뒤에도 결정할 수 있다', last(da.events) === 'done', types(da.events))

  // 승인 대기 중에 멈추면 카드는 취소된다.
  const stop = await fetch(`${BASE}/api/sessions/${b}/stop`, { method: 'POST' })
  const rb2 = (await fetch(`${BASE}/api/sessions/${b}/messages`).then((r) => r.json())) as { messages: { cards?: { status?: string }[] }[]; running?: boolean }
  check('승인 대기 중에 멈추면 카드가 cancelled', stop.status === 204 && !rb2.running && rb2.messages.at(-1)?.cards?.[0]?.status === 'cancelled', rb2)
  const stop2 = await fetch(`${BASE}/api/sessions/${b}/stop`, { method: 'POST' })
  check('처리 중이 아니면 멈추기는 404', stop2.status === 404, stop2.status)
  await post(`/api/sessions/${c2}/approvals/${approvalOf(rc.events)!.approvalId}`, { decision: 'deny' })
  const noRun = await stream(d)
  check('처리 중이 아니면 다시 붙기는 404 NOT_RUNNING', noRun.status === 404, noRun.status)
}
{
  // x 카드가 nginx-web 삭제를 기다리는 사이 y가 같은 대상을 지운다. x를 승인해도 실행하지 않고 모델에 다시 확인하게 한다.
  const [x, y, z] = [await newSession(), await newSession(), await newSession()]
  const rx = await post(`/api/sessions/${x}/messages`, { text: '삭제해줘' })
  const ry = await post(`/api/sessions/${y}/messages`, { text: '삭제해줘' })
  const dy = await post(`/api/sessions/${y}/approvals/${approvalOf(ry.events)!.approvalId}`, { decision: 'approve' })
  const dx = await post(`/api/sessions/${x}/approvals/${approvalOf(rx.events)!.approvalId}`, { decision: 'approve' })
  const blocked = dx.events.find((e) => e.type === 'rejected')
  const restored = (await fetch(`${BASE}/api/sessions/${x}/messages`).then((r) => r.json())) as {
    messages: { cards?: { kind: string; status?: string; code?: string }[] }[]
  }
  const cards = restored.messages.at(-1)?.cards ?? []
  check(
    '먼저 뜬 카드는 그 사이 다른 대화가 같은 대상을 바꿨으면 승인해도 실행하지 않는다(TARGET_CHANGED)',
    text(dy.events).includes('삭제했어요') &&
      blocked?.type === 'rejected' &&
      blocked.code === 'TARGET_CHANGED' &&
      text(dx.events).includes('승인되지 않아서') &&
      last(dx.events) === 'done' &&
      cards.some((c) => c.kind === 'approval' && c.status === 'cancelled') &&
      cards.some((c) => c.kind === 'rejected' && c.code === 'TARGET_CHANGED'),
    { dx: types(dx.events), cards },
  )
  // 바뀐 뒤에 새로 뜬 카드는 지금 상태를 보고 물은 것이므로 그대로 승인된다.
  const rz = await post(`/api/sessions/${z}/messages`, { text: '삭제해줘' })
  const dz = await post(`/api/sessions/${z}/approvals/${approvalOf(rz.events)!.approvalId}`, { decision: 'approve' })
  check('바뀐 뒤에 뜬 카드는 그대로 승인된다', text(dz.events).includes('삭제했어요') && !dz.events.some((e) => e.type === 'rejected'), types(dz.events))
}
{
  // 이름을 바꾸면 ID → 이름 표도 바뀐다. 같은 ID로 부른 다음 카드에 옛 이름이 나오면 안 된다.
  const s = await newSession()
  const r1 = await post(`/api/sessions/${s}/messages`, { text: '이름 바꿔줘' })
  const r2 = await post(`/api/sessions/${s}/approvals/${approvalOf(r1.events)!.approvalId}`, { decision: 'approve' })
  check(
    '이름을 바꾼 뒤 같은 ID로 부르면 카드에 새 이름',
    approvalOf(r1.events)?.summary === '컨테이너 old-web 이름 변경' && approvalOf(r2.events)?.summary === '컨테이너 new-web 재시작',
    [approvalOf(r1.events)?.summary, approvalOf(r2.events)?.summary],
  )
  await post(`/api/sessions/${s}/approvals/${approvalOf(r2.events)!.approvalId}`, { decision: 'deny' })
}
{
  // 브라우저가 중간에 나가도 턴은 계속 돌고, 다시 붙으면 처음부터 끝까지 받는다.
  const s = await newSession()
  const first = await readSome(`/api/sessions/${s}/messages`, { text: '천천히 답해줘' }, 3)
  await sleep(300)
  const again = await stream(s)
  check(
    '중간에 끊고 다시 붙으면 답 전체를 받고 done',
    first.length === 3 && text(again.events).includes('1번째 줄') && text(again.events).includes('15번째 줄') && last(again.events) === 'done',
    { first: types(first), again: types(again.events) },
  )
}
{
  const s = await newSession()
  const ctrl = new AbortController()
  const res = await fetch(`${BASE}/api/sessions/${s}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '천천히 답해줘' }),
    signal: ctrl.signal,
  })
  const events: AgentEvent[] = []
  let stopped = false
  for await (const ev of readSSE(res.body!)) {
    events.push(ev as AgentEvent)
    if (!stopped && (ev as AgentEvent).type === 'text_delta') {
      stopped = true
      await fetch(`${BASE}/api/sessions/${s}/stop`, { method: 'POST' })
    }
  }
  const end = events.at(-1)
  check('처리 중에 멈추면 스트림이 error(STOPPED)로 끝난다', end?.type === 'error' && end.code === 'STOPPED' && !text(events).includes('15번째'), types(events))
}
{
  // 한 턴에서 결정한 카드는 다시 붙을 때 approval_resolved로 온다.
  const s = await newSession()
  const r = await post(`/api/sessions/${s}/messages`, { text: '컨테이너 만들고 시작해줘' })
  const made = await post(`/api/sessions/${s}/approvals/${approvalOf(r.events)!.approvalId}`, { decision: 'approve' })
  const again = await stream(s)
  const resolved = again.events.find((e) => e.type === 'approval_resolved')
  check(
    '다시 붙으면 결정한 카드 뒤에 approval_resolved, 마지막은 다음 카드',
    resolved?.type === 'approval_resolved' && resolved.status === 'approved' && last(again.events) === 'approval_required' &&
      approvalOf(again.events.slice(again.events.indexOf(resolved)))?.approvalId === approvalOf(made.events)?.approvalId,
    types(again.events),
  )
  await post(`/api/sessions/${s}/approvals/${approvalOf(made.events)!.approvalId}`, { decision: 'deny' })
}

// ---- 대화 관리: 제목, 고정, 복제, 내보내기, 사용량 ----
{
  const s = await newSession()
  await post(`/api/sessions/${s}/messages`, { text: '삭제해줘' }).then((r) => post(`/api/sessions/${s}/approvals/${approvalOf(r.events)!.approvalId}`, { decision: 'deny' }))
  await post(`/api/sessions/${s}/messages`, { text: '두 번째 질문' })
  const patch = (body: unknown) =>
    fetch(`${BASE}/api/sessions/${s}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const bad = await patch({ title: '   ' })
  const ok = await patch({ title: '정리한 제목', pinned: true })
  const list = (await fetch(`${BASE}/api/sessions`).then((r) => r.json())) as {
    sessions: { sessionId: string; title: string; pinned?: boolean; inputTokens?: number }[]
  }
  const row = list.sessions.find((x) => x.sessionId === s)
  check('제목 바꾸기와 고정', bad.status === 400 && ok.status === 204 && row?.title === '정리한 제목' && row.pinned === true, row)
  check('대화 목록에 토큰 사용량', (row?.inputTokens ?? 0) > 0, row)

  const fork = await post(`/api/sessions/${s}/fork`, { turn: 1 })
  const forkId = (fork.json as { sessionId: string }).sessionId
  const restored = (await fetch(`${BASE}/api/sessions/${forkId}/messages`).then((r) => r.json())) as {
    messages: { role: string; content: string; cards?: { kind: string; status?: string }[] }[]
  }
  check(
    '복제하면 그 메시지 직전까지 복사되고 카드도 따라온다',
    fork.status === 201 && restored.messages.filter((m) => m.role === 'user').length === 1 && restored.messages[1]?.cards?.[0]?.status === 'denied',
    restored,
  )
  const badFork = await post(`/api/sessions/${s}/fork`, { turn: 9 })
  check('없는 메시지로 복제하면 400', badFork.status === 400, badFork.status)

  const exp = await fetch(`${BASE}/api/sessions/${s}/export`)
  const md = await exp.text()
  check(
    '마크다운으로 내보내기',
    exp.headers.get('content-type')?.startsWith('text/markdown') === true && md.includes('# 정리한 제목') && md.includes('## 사용자') && md.includes('거부함'),
    md.slice(0, 200),
  )
  const usage = (await fetch(`${BASE}/api/sessions/${s}/usage`).then((r) => r.json())) as { inputTokens: number; cost?: number }
  check('대화 사용량에 토큰과 비용', usage.inputTokens > 0 && typeof usage.cost === 'number', usage)
  await patch({ pinned: false })
}

// ---- 정보·정책 화면, 승인 기록 ----
{
  const res = await fetch(`${BASE}/api/system`)
  const raw = await res.text()
  const info = JSON.parse(raw) as {
    agent: { reachable: boolean; version?: string }
    config?: { permissions: { allow: string[] }; agents: { hooks: { scripts: string[] }[]; toolsets: { env: string[] }[] }[] }
  }
  check('정보 화면: Agent 연결과 버전', info.agent.reachable && info.agent.version === 'v1.148.0-fake', info.agent)
  check('정책 화면: permissions와 훅 스크립트 이름', info.config?.permissions.allow.includes('docker_proxy:method=GET') === true && info.config.agents[0].hooks[0].scripts[0] === 'policy_guard.py', info.config)
  check('설정 요약에 경로·env 값이 없다', !raw.includes('C:/') && !raw.includes('${env') && info.config?.agents[0].toolsets[0].env.includes('PORTAINER_URL') === true, raw.slice(0, 300))
  const tools = (await fetch(`${BASE}/api/system/tools`).then((r) => r.json())) as { count: number }
  check('정보 화면: 도구 수', tools.count === 2, tools)
  const audit = (await fetch(`${BASE}/api/audit?limit=5`).then((r) => r.json())) as { records: { decision: string; summary?: string }[] }
  check('승인 기록: 최근 순으로 카드 요약과 함께', audit.records.length === 5 && audit.records.some((r) => r.summary), audit.records)
}

// ---- 백업 목록(Agent 백업 훅의 SQLite를 읽기만) ----
{
  // 지난 실행이 넣은 행이 남아 있으면 빈 목록 검사가 틀리므로 먼저 지운다.
  const file = `${dirname(process.env.AGENT_ENV_FILE!)}/backups.sqlite3`
  rmSync(file, { force: true })
  const empty = (await fetch(`${BASE}/api/backups`).then((r) => r.json())) as { available: boolean; records: unknown[] }
  check('백업 파일이 없으면 빈 목록', empty.available && empty.records.length === 0, empty)
  // 훅과 같은 표를 만든다(tool_input_transform_direct_backup_guard.py save).
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file)
  db.exec(
    'CREATE TABLE IF NOT EXISTS backups (ts REAL, time TEXT, session_id TEXT, environment_id TEXT, method TEXT, path TEXT, query_json TEXT, kind TEXT, target TEXT, inspect_json TEXT)',
  )
  const inspect = {
    Name: '/web',
    Config: { Image: 'nginx:alpine', Env: ['DB_PASSWORD=super-secret-value', 'TZ=Asia/Seoul'], Cmd: ['nginx', '-g', 'daemon off;'] },
    HostConfig: { PortBindings: { '80/tcp': [{ HostPort: '8080' }] }, RestartPolicy: { Name: 'unless-stopped' } },
    State: { Status: 'exited' },
  }
  db.prepare('INSERT INTO backups VALUES (?,?,?,?,?,?,?,?,?,?)').run(Date.now() / 1000, '', sid, '1', 'DELETE', '/containers/web', '{}', 'container', 'web', JSON.stringify(inspect))
  db.close()
  const res = await fetch(`${BASE}/api/backups`)
  const raw = await res.text()
  const list = JSON.parse(raw) as { records: { kind: string; summary: Record<string, string> }[] }
  const s = list.records[0]?.summary ?? {}
  check('백업 목록에 이미지·포트·재시작 정책', s.이미지 === 'nginx:alpine' && s.포트 === '8080 → 80/tcp' && s['재시작 정책'] === 'unless-stopped', list)
  check('백업 목록에 환경변수 값이 없다', !raw.includes('super-secret-value') && s.환경변수?.includes('DB_PASSWORD') === true, raw.slice(0, 300))

  // 백업은 승인 전에 만들어진다. 같은 대화에서 바로 뒤에 뜬 삭제 카드의 결정으로 실제 삭제 여부를 보여준다.
  const backupFor = async (decision: string | null) => {
    const s = await newSession()
    const r = await post(`/api/sessions/${s}/messages`, { text: '삭제해줘' })
    const bdb = new DatabaseSync(file)
    bdb.prepare('INSERT INTO backups VALUES (?,?,?,?,?,?,?,?,?,?)').run((Date.now() - 2000) / 1000, '', s, '1', 'DELETE', '/containers/nginx-web', '{}', 'container', 'nginx-web', JSON.stringify(inspect))
    bdb.close()
    if (decision) await post(`/api/sessions/${s}/approvals/${approvalOf(r.events)!.approvalId}`, { decision })
    const rows = (await fetch(`${BASE}/api/backups`).then((res) => res.json())) as { records: { sessionId: string; outcome: string }[] }
    const outcome = rows.records.find((x) => x.sessionId === s)?.outcome
    if (!decision) await post(`/api/sessions/${s}/approvals/${approvalOf(r.events)!.approvalId}`, { decision: 'deny' })
    return outcome
  }
  const [pending, kept, deleted] = [await backupFor(null), await backupFor('deny'), await backupFor('approve')]
  check('백업 목록에 삭제 여부: 대기·거부·승인', pending === 'pending' && kept === 'kept' && deleted === 'deleted', [pending, kept, deleted])
  const older = list.records.find((x) => x.kind === 'container')
  check('짝지을 카드가 없는 백업은 unknown', (older as { outcome?: string } | undefined)?.outcome === 'unknown', older)
}

// ---- 전체 사용량 ----
{
  const totals = (await fetch(`${BASE}/api/usage`).then((r) => r.json())) as Record<'today' | 'month' | 'total', { inputTokens: number; outputTokens: number; cost: number }>
  check(
    '전체 사용량: 턴마다 기록돼 오늘·이번 달·전체에 쌓인다',
    totals.today.inputTokens > 0 && totals.today.cost > 0 && totals.month.inputTokens >= totals.today.inputTokens && totals.total.inputTokens >= totals.month.inputTokens,
    totals,
  )
}

// ---- 스택 카드(Secure 정책표: 생성은 스택으로만) ----
{
  const s = await newSession()
  const r = await post(`/api/sessions/${s}/messages`, { text: '스택 배포해줘' })
  const ap = approvalOf(r.events)
  const p = ap?.action.params ?? {}
  check(
    '스택 배포 카드: 서비스·포트·호스트 경로와 새로 만듦',
    ap?.summary === '스택 shop 배포' && ap.risk?.level === 'low' &&
      String(p.서비스).includes('web (nginx:alpine)') && String(p.서비스).includes('db (postgres:16)') &&
      String(p.포트).includes('8081:80 (web)') && ap.reasons.some((x) => x.code === 'HOST_MOUNT' && x.message.includes('./html')),
    ap,
  )
  check(
    '스택 배포 카드에 환경변수 값이 없다(compose·스택 Env 모두)',
    !JSON.stringify(ap).includes('super-secret') && String(p.환경변수).includes('POSTGRES_PASSWORD') && String(p['스택 환경변수']).includes('API_TOKEN') &&
      String(p['compose 파일']).includes('POSTGRES_PASSWORD: ••••'),
    p,
  )
  await post(`/api/sessions/${s}/approvals/${ap!.approvalId}`, { decision: 'approve' })

  const u = await post(`/api/sessions/${s}/messages`, { text: '스택 수정해줘' })
  const up = approvalOf(u.events)
  check(
    '스택 수정 카드: 이름, 빠지는 서비스 경고, 새 서비스, 명령',
    up?.summary === '스택 shop 수정' && up.action.target === 'shop (스택 ID 7)' && up.risk?.level === 'medium' &&
      up.action.params?.['빠지는 서비스'] === 'cache' && up.action.params?.['새 서비스'] === 'worker' &&
      up.reasons.some((x) => x.code === 'ORPHANS' && x.message.includes('cache')) && up.reasons.some((x) => x.code === 'COMMAND'),
    up,
  )
  await post(`/api/sessions/${s}/approvals/${up!.approvalId}`, { decision: 'deny' })

  const st = await post(`/api/sessions/${s}/messages`, { text: '스택 중지해줘' })
  const sp = approvalOf(st.events)
  check('스택 중지 카드: 서비스 멈춤', sp?.summary === '스택 shop 중지' && sp.risk?.label === '서비스 멈춤', sp)
  await post(`/api/sessions/${s}/approvals/${sp!.approvalId}`, { decision: 'deny' })

  const d = await post(`/api/sessions/${s}/messages`, { text: '스택 삭제해줘' })
  const dp = approvalOf(d.events)
  check(
    '스택 삭제 카드: 되돌릴 수 없음, 볼륨 데이터 경고, 서비스 목록',
    dp?.summary === '스택 shop 삭제' && dp.risk?.level === 'high' && dp.reasons.some((x) => x.code === 'VOLUMES') &&
      String(dp.action.params?.서비스).includes('cache'),
    dp,
  )
  await post(`/api/sessions/${s}/approvals/${dp!.approvalId}`, { decision: 'deny' })

  const k = await post(`/api/sessions/${s}/messages`, { text: '소켓 스택 만들어줘' })
  const kp = approvalOf(k.events)
  check('Docker 소켓을 연결하는 스택은 호스트까지 영향', kp?.risk?.level === 'high' && kp.reasons.some((x) => x.code === 'HOST_TAKEOVER'), kp)
  await post(`/api/sessions/${s}/approvals/${kp!.approvalId}`, { decision: 'deny' })
}

// ---- 승인 방식(YOLO) ----
{
  const mode = (approvalMode: string) =>
    fetch(`${BASE}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvalMode }) })
  const bad = await mode('sometimes')
  const initial = (await fetch(`${BASE}/api/settings`).then((r) => r.json())) as { approvalMode: string }
  check('승인 방식 기본은 ask, 모르는 값은 400', bad.status === 400 && initial.approvalMode === 'ask', [bad.status, initial.approvalMode])

  const ok = await mode('never')
  check('승인 방식 저장', ok.status === 200 && ((await ok.json()) as { approvalMode: string }).approvalMode === 'never', ok.status)
  const s = await newSession()
  const r = await post(`/api/sessions/${s}/messages`, { text: '삭제해줘' })
  const auto = r.events.find((e) => e.type === 'auto_approved')
  check(
    '묻지 않기: 카드 없이 auto_approved → 실행 → done',
    auto?.type === 'auto_approved' && auto.summary === '컨테이너 nginx-web 삭제' && !types(r.events).includes('approval_required') &&
      text(r.events).includes('삭제했어요') && last(r.events) === 'done',
    types(r.events),
  )
  const restored = (await fetch(`${BASE}/api/sessions/${s}/messages`).then((res) => res.json())) as {
    messages: { cards?: { kind: string; status?: string; auto?: boolean }[] }[]
  }
  const card = restored.messages.flatMap((m) => m.cards ?? [])[0]
  check('대신 승인한 카드는 approved + auto로 복원', card?.status === 'approved' && card.auto === true, card)
  const audit = (await fetch(`${BASE}/api/audit?sessionId=${s}`).then((res) => res.json())) as { records: { user: string; decision: string }[] }
  check('승인 기록에 user auto', audit.records[0]?.user === 'auto' && audit.records[0].decision === 'approved', audit.records)
  const hooked = await post(`/api/sessions/${s}/messages`, { text: '명령 실행해줘' })
  check('묻지 않기에서도 permissions.deny는 막힌다', types(hooked.events).includes('rejected') && !types(hooked.events).includes('auto_approved'), types(hooked.events))

  await mode('risky')
  const s2 = await newSession()
  const restart = await post(`/api/sessions/${s2}/messages`, { text: 'web 재시작해줘' })
  check('위험한 작업만 묻기: 재시작(잠깐 끊김)은 대신 승인', types(restart.events).includes('auto_approved') && last(restart.events) === 'done', types(restart.events))
  const del = await post(`/api/sessions/${s2}/messages`, { text: '삭제해줘' })
  check('위험한 작업만 묻기: 삭제는 카드', last(del.events) === 'approval_required' && !types(del.events).includes('auto_approved'), types(del.events))
  await post(`/api/sessions/${s2}/approvals/${approvalOf(del.events)!.approvalId}`, { decision: 'deny' })
  const unknown = await post(`/api/sessions/${s2}/messages`, { text: '모르는 도구 써줘' })
  check('위험한 작업만 묻기: 모르는 도구는 카드', last(unknown.events) === 'approval_required', types(unknown.events))
  await post(`/api/sessions/${s2}/approvals/${approvalOf(unknown.events)!.approvalId}`, { decision: 'deny' })

  // 다른 대화가 같은 대상의 결정을 기다리면 대신 승인하지 않고 묻는다.
  await mode('ask')
  const [a, b] = [await newSession(), await newSession()]
  const ra = await post(`/api/sessions/${a}/messages`, { text: '삭제해줘' })
  await mode('never')
  const rb = await post(`/api/sessions/${b}/messages`, { text: '삭제해줘' })
  check(
    '같은 대상을 다른 대화가 기다리면 묻지 않기여도 카드(CONCURRENT)',
    last(rb.events) === 'approval_required' && approvalOf(rb.events)?.reasons.some((x) => x.code === 'CONCURRENT') === true,
    types(rb.events),
  )
  await mode('ask')
  await post(`/api/sessions/${a}/approvals/${approvalOf(ra.events)!.approvalId}`, { decision: 'deny' })
  await post(`/api/sessions/${b}/approvals/${approvalOf(rb.events)!.approvalId}`, { decision: 'deny' })
}

// ---- 모델 관리 ----
{
  const add = (model: string) => post('/api/settings/models', { model })
  const bad = await add('bad model!')
  const ok = await add('openrouter/test/model-1')
  const settings = ok.json as { models: string[]; customModels: string[] }
  check('모델 더하기', bad.status === 400 && settings.models.includes('openrouter/test/model-1') && settings.customModels.includes('openrouter/test/model-1'), settings)
  const envModel = settings.models.find((m) => !settings.customModels.includes(m))!
  const delEnv = await fetch(`${BASE}/api/settings/models?model=${encodeURIComponent(envModel)}`, { method: 'DELETE' })
  const del = await fetch(`${BASE}/api/settings/models?model=${encodeURIComponent('openrouter/test/model-1')}`, { method: 'DELETE' })
  const after = (await del.json()) as { models: string[] }
  check('더한 모델만 지울 수 있다', delEnv.status === 400 && del.status === 200 && !after.models.includes('openrouter/test/model-1'), after)
}

{
  // 승인 감사 기록에는 화면에서 누른 결정이 local로 남는다(만료 자동 거부는 system).
  const db = process.env.WEB_DB_PATH
  if (db && db !== ':memory:') {
    const { DatabaseSync } = await import('node:sqlite')
    const users = new DatabaseSync(db).prepare("SELECT DISTINCT user FROM approval_audit WHERE user != 'system'").all()
    check('승인 감사 기록의 user는 local 또는 auto(대신 승인)', users.every((u) => u.user === 'local' || u.user === 'auto'), users)
  }
}

console.info(failures ? `${failures} failure(s)` : 'all passed')
process.exit(failures ? 1 : 0)
