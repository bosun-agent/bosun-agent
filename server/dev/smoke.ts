// 가짜 Agent를 띄운 상태에서 WEB 백엔드 흐름을 확인하는 스모크 테스트.
// 실행: npm run server:fake, npm run server를 띄운 뒤 npm run server:smoke

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentEvent } from '../../src/lib/agentProtocol.ts'
import { readSSE } from '../../src/lib/sse.ts'

const BASE = `http://127.0.0.1:${process.env.PORT ?? 3001}`
let failures = 0

function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++
  console.info(`${ok ? 'ok  ' : 'FAIL'} ${name}`, ok ? '' : JSON.stringify(detail))
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
  const busy = await send('목록')
  check('승인 대기 중 새 메시지는 409', busy.status === 409, busy)
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
  const d = await decide(ap!.approvalId, 'approve')
  const tools = d.events.filter((e) => e.type === 'tool_status')
  check('승인 뒤 처리 과정에 작업 이름이 보인다', JSON.stringify(tools).includes('재시작 완료'), tools)
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
  const d = await decide(ap!.approvalId, 'deny')
  // 도구 호출 앞뒤 문장이 붙지 않게 빈 줄이 들어간다.
  check('도구 호출 뒤 문장은 빈 줄로 나뉜다', text(d.events).startsWith('\n\n승인되지 않아서'), text(d.events))
}
{
  const r = await send('명령 실행해줘')
  check('exec는 승인 카드 없이 rejected', types(r.events).includes('rejected') && !types(r.events).includes('approval_required'), types(r.events))
}
{
  const r = await send('차단되는 작업')
  check('tool_guard 거부는 rejected + done', types(r.events).includes('rejected') && last(r.events) === 'done', types(r.events))
}
{
  const r = await send('금지된 도구 써줘')
  check('permissions.deny는 rejected', types(r.events).includes('rejected'), types(r.events))
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
  check('대화 복원에 사용자 메시지가 모두 있다', messages.filter((m) => m.role === 'user').length === 13, messages.length)
  check('대화 복원에 승인·차단 카드가 붙는다', withCards.length === 8, withCards)
}
{
  const r = await send('만료 테스트')
  const ap = approvalOf(r.events)
  const timeout = Number(process.env.APPROVAL_TIMEOUT_MS || 300_000)
  const wait = new Date(ap!.expiresAt).getTime() - Date.now()
  check('만료 시각은 카드를 띄운 때 + APPROVAL_TIMEOUT_MS', wait > timeout - 5_000 && wait <= timeout, wait)
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
{
  const put = (model: string) =>
    fetch(`${BASE}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) })
  const bad = await put('openrouter/unknown/model')
  check('목록에 없는 모델은 400', bad.status === 400, bad.status)
  const settings = (await fetch(`${BASE}/api/settings`).then((r) => r.json())) as { models: string[] }
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
  // 키 저장은 Agent env 파일의 키 줄만 바꾸고 Portainer 줄은 남긴다(계약 7장 ①).
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

console.info(failures ? `${failures} failure(s)` : 'all passed')
process.exit(failures ? 1 : 0)
