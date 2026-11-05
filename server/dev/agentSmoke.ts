// WEB 백엔드가 Agent를 띄우고 관리하는 흐름(server/agentProcess.ts)을 가짜 Agent로 확인한다.
// 실행: npm run test:agent. 이 스크립트가 백엔드를 직접 띄우고 끈다(포트 13011~13013, 가짜 Agent 18090~18092).
// 다른 백엔드·가짜 Agent는 띄워 두지 않아도 된다.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProcessStatus } from '../../src/lib/agentProtocol.ts'

let failures = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++
  console.info(`${ok ? 'ok  ' : 'FAIL'} ${name}`, ok ? '' : JSON.stringify(detail))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const dir = mkdtempSync(join(tmpdir(), 'bosun-agent-smoke-'))
const H = { 'X-Bosun': '1', 'Content-Type': 'application/json' }

function startBackend(port: number, agentPort: number, extra: Record<string, string> = {}, db = join(dir, 'web.db')): ChildProcess {
  return spawn(process.execPath, ['--env-file=server/dev/dev.env', 'server/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_URL: `http://127.0.0.1:${agentPort}`,
      AGENT_BIN: 'server/dev/fakeAgentBin.ts',
      AGENT_CONFIG: 'server/dev/agent.yaml',
      AGENT_ENV_FILE: join(dir, 'agent.env'),
      WEB_DB_PATH: db,
      ...extra,
    },
    stdio: process.env.VERBOSE ? 'inherit' : 'ignore',
  })
}

// 백엔드만 강제로 끈다(Ctrl+C가 아니라서 Agent는 남는다). tree면 Agent까지 끈다.
function killBackend(proc: ChildProcess, tree: boolean) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/F', ...(tree ? ['/T'] : [])], { stdio: 'ignore' })
  else proc.kill('SIGKILL')
}

async function status(port: number): Promise<AgentProcessStatus | null> {
  return fetch(`http://127.0.0.1:${port}/api/agent`).then(
    (r) => r.json() as Promise<AgentProcessStatus>,
    () => null,
  )
}

async function waitFor(port: number, ok: (s: AgentProcessStatus) => boolean, ms = 20_000): Promise<AgentProcessStatus | null> {
  const deadline = Date.now() + ms
  let last: AgentProcessStatus | null = null
  while (Date.now() < deadline) {
    last = await status(port)
    if (last && ok(last)) return last
    await sleep(200)
  }
  return last
}

const agentAnswers = (agentPort: number) =>
  fetch(`http://127.0.0.1:${agentPort}/health`).then(
    (r) => r.ok,
    () => false,
  )

const A = 13011
const backends: ChildProcess[] = []
try {
  // 1. 띄우기
  let web = startBackend(A, 18090)
  backends.push(web)
  let s = await waitFor(A, (x) => x.state === 'running')
  check('AGENT_BIN이 있으면 백엔드가 Agent를 띄운다', s?.managed === true && s.state === 'running' && s.reachable === true, s)

  // 2. API 키를 바꾸면 다시 시작한다. 켜는 동안 새 메시지는 503
  const { sessionId } = (await (await fetch(`http://127.0.0.1:${A}/api/sessions`, { method: 'POST', headers: H })).json()) as { sessionId: string }
  const saved = (await (await fetch(`http://127.0.0.1:${A}/api/settings/api-key`, { method: 'PUT', headers: H, body: JSON.stringify({ apiKey: 'sk-test-123456789' }) })).json()) as { agentRestart?: string }
  const during = await fetch(`http://127.0.0.1:${A}/api/sessions/${sessionId}/messages`, { method: 'POST', headers: H, body: JSON.stringify({ text: '안녕' }) })
  const duringBody = (await during.json()) as { error?: string }
  check('키를 저장하면 바로 다시 시작(started), 켜는 동안 메시지는 503 AGENT_STARTING', saved.agentRestart === 'started' && during.status === 503 && duringBody.error === 'AGENT_STARTING', [saved, during.status, duringBody])
  s = await waitFor(A, (x) => x.state === 'running' && x.restarts === 1)
  check('다시 시작한 뒤 running, restarts 1', s?.state === 'running' && s.restarts === 1, s)

  // 3. 처리 중인 대화가 있으면 끝난 뒤에 다시 시작한다
  const { sessionId: slow } = (await (await fetch(`http://127.0.0.1:${A}/api/sessions`, { method: 'POST', headers: H })).json()) as { sessionId: string }
  const turn = fetch(`http://127.0.0.1:${A}/api/sessions/${slow}/messages`, { method: 'POST', headers: H, body: JSON.stringify({ text: '천천히 답해줘' }) }).then((r) => r.text())
  await sleep(500)
  const waiting = (await (await fetch(`http://127.0.0.1:${A}/api/agent/restart`, { method: 'POST', headers: H })).json()) as { restart: string; status: AgentProcessStatus }
  check('처리 중이면 다시 시작을 미룬다(waiting, pendingRestart)', waiting.restart === 'waiting' && waiting.status.pendingRestart === true && waiting.status.state === 'running', waiting)
  const reply = await turn
  check('미룬 동안 처리 중인 대화는 끝까지 받는다', reply.includes('"type":"done"'), reply.slice(-200))
  s = await waitFor(A, (x) => x.state === 'running' && x.restarts === 2 && !x.pendingRestart)
  check('대화가 끝나면 다시 시작한다', s?.restarts === 2 && !s.pendingRestart, s)

  // 4. 백엔드가 강제로 꺼져 Agent가 남으면, 다음에 뜰 때 그 Agent를 끝내고 새로 띄운다
  killBackend(web, false)
  await sleep(500)
  // 출력 파이프가 끊긴 Agent는 다음 출력 때 스스로 끝나기도 한다. 같이 끝났으면 남은 Agent를 직접 만든다.
  let leftover: ChildProcess | null = null
  if (!(await agentAnswers(18090))) {
    leftover = spawn(process.execPath, ['server/dev/fakeAgentBin.ts', 'serve', 'api', 'x.yaml', '-l', '127.0.0.1:18090'], { stdio: 'ignore' })
    backends.push(leftover)
    for (let i = 0; i < 50 && !(await agentAnswers(18090)); i++) await sleep(100)
    writeFileSync(join(dir, 'agent.pid'), String(leftover.pid))
  }
  web = startBackend(A, 18090)
  backends.push(web)
  s = await waitFor(A, (x) => x.state === 'running' || x.state === 'external')
  check('남은 Agent는 PID 파일로 알아보고 새로 띄운다(external 아님)', s?.state === 'running' && s.restarts === 0 && (!leftover || leftover.exitCode !== null || leftover.signalCode !== null), [s, leftover?.exitCode])

  // 5. WEB이 띄우지 않은 Agent가 이미 있으면 그것을 쓰고, 다시 시작은 사람에게 맡긴다
  const B = 13012
  const other = spawn(process.execPath, ['server/dev/fakeAgentBin.ts', 'serve', 'api', 'x.yaml', '-l', '127.0.0.1:18091'], { stdio: 'ignore' })
  backends.push(other)
  for (let i = 0; i < 50 && !(await agentAnswers(18091)); i++) await sleep(100)
  const webB = startBackend(B, 18091, {}, join(dir, 'b.db'))
  backends.push(webB)
  s = await waitFor(B, (x) => x.state !== 'starting')
  const manual = (await (await fetch(`http://127.0.0.1:${B}/api/agent/restart`, { method: 'POST', headers: H })).json()) as { restart: string }
  check('따로 띄운 Agent가 있으면 external, 다시 시작은 manual', s?.state === 'external' && manual.restart === 'manual', [s, manual])

  // 6. Agent가 죽으면 다시 띄운다
  const C = 13013
  const webC = startBackend(C, 18092, { FAKE_AGENT_EXIT_MS: '1500' }, join(dir, 'c.db'))
  backends.push(webC)
  s = await waitFor(C, (x) => x.restarts >= 1 && x.state === 'running', 15_000)
  check('Agent가 죽으면 잠시 뒤 다시 띄운다', s !== null && s.restarts >= 1, s)
} finally {
  for (const proc of backends) killBackend(proc, true)
  await sleep(500)
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
}

console.info(failures ? `${failures} failure(s)` : 'all passed')
process.exit(failures ? 1 : 0)
