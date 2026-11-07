// WEB 백엔드가 Docker Agent를 자식 프로세스로 띄우고 관리한다.
// - AGENT_BIN이 있을 때만 관리한다. 없으면(개발용 가짜 Agent, 다른 PC의 Agent) AGENT_URL에 붙기만 한다.
// - 이미 AGENT_URL에서 Agent가 응답하면 새로 띄우지 않고 그 Agent를 쓴다(`npm run agent`로 따로 띄운 경우 등).
//   그 Agent는 WEB이 다시 시작할 수 없다(external). 다만 지난번에 WEB이 띄운 Agent가 남아 있던 것이면
//   (백엔드가 강제로 꺼지면 Windows에서는 자식이 남는다) PID 파일로 알아보고 끝낸 뒤 새로 띄운다.
// - 죽으면 잠시 뒤 다시 띄운다. 짧은 시간에 여러 번 죽으면 멈추고 화면에 알린다(crashed).
// - API 키를 바꾸면 다시 시작한다. Agent는 키를 시작할 때 한 번 읽기 때문이다.
//   처리 중인 대화가 있으면 끝난 뒤에 한다. 다시 시작하면 Docker Agent가 기다리던 승인과 실행을 취소한다.
// - 띄우는 명령은 `npm run agent`(server/runAgent.ts)와 같다.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AgentProcessStatus } from '../src/lib/agentProtocol.ts'
import * as agent from './agentClient.ts'
import { config } from './config.ts'
import { maskText } from './mask.ts'

export interface AgentCommand {
  bin: string
  args: string[]
  // 화면·로그에 찍는 한 줄. 토큰은 넣지 않는다.
  describe: string
}

// 실행 파일, agent.yaml, session.db 위치. 문제가 있으면 문장으로 돌려준다.
export function agentCommand(): AgentCommand | string {
  if (!config.agentEnvFile) return 'AGENT_ENV_FILE이 없어요. server/real.env에 Agent env 파일 경로를 넣어주세요.'
  const dir = dirname(config.agentEnvFile)
  const agentYaml = config.agentConfig || join(dir, `${config.agentName}.yaml`)
  const sessionDb = config.agentSessionDb || join(dir, 'session.db')
  if (!existsSync(agentYaml)) return `Agent 설정 파일이 없어요: ${agentYaml} (AGENT_NAME이나 AGENT_CONFIG를 확인해주세요)`
  const listen = new URL(config.agentUrl).host
  let bin = config.agentBin || 'docker-agent'
  const args = ['serve', 'api', agentYaml, '--env-from-file', config.agentEnvFile, '--session-db', sessionDb, '-l', listen]
  if (config.agentToken) args.push('--auth-token', config.agentToken)
  // 스크립트면 Node로 돌린다(개발용 가짜 Agent, server/dev/fakeAgentBin.ts).
  if (/\.(ts|js|mjs)$/.test(bin)) {
    args.unshift(bin)
    bin = process.execPath
  }
  return { bin, args, describe: `${config.agentBin || 'docker-agent'} serve api ${agentYaml} (listen ${listen}, session ${sessionDb})` }
}

// WEB이 띄운 Agent의 PID. WEB 저장소(web.db) 옆에 둔다.
const PID_FILE = config.dbPath === ':memory:' ? '' : join(dirname(config.dbPath), 'agent.pid')

function savePid(pid: number | undefined) {
  if (!PID_FILE) return
  try {
    if (pid) writeFileSync(PID_FILE, String(pid))
    else rmSync(PID_FILE, { force: true })
  } catch (err) {
    console.warn('[agent] pid file', err)
  }
}

// 그 PID가 아직 살아 있고 같은 실행 파일이면 실행 파일 이름을, 아니면 null. PID가 다른 프로그램에 다시 쓰였으면 끝내지 않는다.
function leftoverImage(pid: number): string | null {
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).split(',')[0].replace(/"/g, '').trim()
        : execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim()
    return out && !out.startsWith('INFO:') ? basename(out) : null
  } catch {
    return null
  }
}

// 지난번에 WEB이 띄운 Agent가 남아 있으면 끝낸다. 끝냈으면 true.
function killLeftover(cmd: AgentCommand): boolean {
  if (!PID_FILE || !existsSync(PID_FILE)) return false
  const pid = Number(readFileSync(PID_FILE, 'utf8'))
  savePid(undefined)
  if (!Number.isInteger(pid) || pid <= 0) return false
  const image = leftoverImage(pid)
  if (!image || image.toLowerCase().replace(/\.exe$/, '') !== basename(cmd.bin).toLowerCase().replace(/\.exe$/, '')) return false
  console.warn(`[agent] stopping the Agent left from the last run (pid ${pid})`)
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(pid, 'SIGTERM')
  } catch {
    return false
  }
  return true
}

const READY_TIMEOUT_MS = 60_000
// 이 시간 안에 MAX_CRASHES번 죽으면 다시 띄우지 않는다.
const CRASH_WINDOW_MS = 120_000
const MAX_CRASHES = 5
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

let state: AgentProcessStatus['state'] = config.agentBin ? 'starting' : 'off'
let child: ChildProcess | null = null
let lastError = ''
let restarts = 0
let crashes: number[] = []
let pendingRestart = false
let stopping = false
let isIdle: () => boolean = () => true
// 다시 띄우기를 기다리는 중에 화면에서 다시 시작을 누르면 앞의 기다림은 버린다.
let generation = 0

export function agentStatus(): AgentProcessStatus {
  return {
    managed: config.agentBin !== '',
    state,
    restarts,
    ...(pendingRestart ? { pendingRestart } : {}),
    ...(lastError && state !== 'running' ? { error: lastError } : {}),
  }
}

// 다시 시작하는 동안에는 새 메시지를 받지 않는다(app.ts가 503으로 돌려준다).
export function agentStarting(): boolean {
  return state === 'starting' || state === 'restarting'
}

async function responds(): Promise<boolean> {
  try {
    return (await agent.health()).status === 'ok'
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 프로세스 트리를 끝낸다. Windows에서는 Agent가 띄운 MCP 서버(uvx, python)까지 같이 끝내야 한다.
function kill(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
    proc.once('exit', () => resolve())
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => proc.kill())
    } else {
      proc.kill('SIGTERM')
      setTimeout(() => proc.kill('SIGKILL'), 5_000).unref()
    }
  })
}

// Agent 출력은 앞에 [agent]를 붙여 그대로 찍는다. 마지막 오류 줄은 화면에 보여주려고 가려서 남긴다.
function pipe(stream: NodeJS.ReadableStream | null, write: (line: string) => void) {
  let buffer = ''
  stream?.setEncoding('utf8')
  stream?.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) write(line)
  })
}

async function spawnAgent(): Promise<void> {
  const cmd = agentCommand()
  if (typeof cmd === 'string') {
    state = 'crashed'
    lastError = cmd
    console.error(`[agent] ${cmd}`)
    return
  }
  console.info(`[agent] ${cmd.describe}`)
  const proc = spawn(cmd.bin, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child = proc
  savePid(proc.pid)
  pipe(proc.stdout, (line) => console.info(`[agent] ${line}`))
  pipe(proc.stderr, (line) => {
    console.error(`[agent] ${line}`)
    if (/error|fatal|panic|failed/i.test(line)) lastError = maskText(line).slice(0, 300)
  })
  // 실행 파일이 없으면 다시 띄워도 소용없다.
  proc.on('error', (err) => {
    if (child !== proc) return
    child = null
    state = 'crashed'
    lastError = `${cmd.bin}를 실행하지 못했어요: ${err.message}. server/real.env의 AGENT_BIN을 확인해주세요.`
    console.error(`[agent] ${lastError}`)
  })
  proc.on('exit', (code, signal) => {
    if (child !== proc) return
    child = null
    savePid(undefined)
    if (stopping) return
    // 다시 시작하려고 끝낸 것은 죽은 것으로 세지 않는다(restart가 child를 먼저 비운다).
    console.warn(`[agent] exited (${signal ?? code})`)
    if (!lastError) lastError = `AI Agent가 멈췄어요(종료 코드 ${signal ?? code}).`
    void recover()
  })

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline && child === proc) {
    if (await responds()) {
      state = 'running'
      lastError = ''
      console.info('[agent] ready')
      return
    }
    await sleep(500)
  }
  if (child === proc) {
    lastError = `AI Agent가 ${READY_TIMEOUT_MS / 1000}초 안에 응답하지 않았어요.`
    child = null
    await kill(proc)
    void recover()
  }
}

async function recover(): Promise<void> {
  const now = Date.now()
  crashes = [...crashes.filter((t) => now - t < CRASH_WINDOW_MS), now]
  if (crashes.length >= MAX_CRASHES) {
    state = 'crashed'
    console.error(`[agent] crashed ${crashes.length} times in ${CRASH_WINDOW_MS / 1000}s; not restarting`)
    return
  }
  state = 'restarting'
  const gen = ++generation
  await sleep(BACKOFF_MS[Math.min(crashes.length - 1, BACKOFF_MS.length - 1)])
  if (stopping || gen !== generation) return
  restarts++
  await spawnAgent()
}

// main.ts가 시작할 때 부른다. isIdle은 처리 중인 대화가 없는지 알려준다(turns.ts runningCount).
export async function startAgent(idle: () => boolean): Promise<void> {
  isIdle = idle
  if (!config.agentBin) return
  const cmd = agentCommand()
  if (typeof cmd !== 'string' && (await responds()) && killLeftover(cmd)) {
    // 포트가 풀릴 때까지 기다린다.
    for (let i = 0; i < 20 && (await responds()); i++) await sleep(250)
  }
  if (await responds()) {
    state = 'external'
    console.warn(`[agent] something already answers at ${config.agentUrl}; using it. WEB cannot restart it (e.g. after an API key change)`)
    return
  }
  await spawnAgent()
}

export type RestartResult = 'started' | 'waiting' | 'manual'

async function restartNow(): Promise<void> {
  generation++
  pendingRestart = false
  state = 'restarting'
  crashes = []
  lastError = ''
  const proc = child
  child = null
  if (proc) await kill(proc)
  restarts++
  await spawnAgent()
}

// 처리 중인 대화가 있으면 끝날 때까지 기다렸다가 다시 시작한다. WEB이 띄운 Agent가 아니면 'manual'.
export function restartAgent(): RestartResult {
  if (state === 'off' || state === 'external') return 'manual'
  if (isIdle()) {
    void restartNow()
    return 'started'
  }
  if (!pendingRestart) {
    pendingRestart = true
    const timer = setInterval(() => {
      if (!pendingRestart || stopping) return clearInterval(timer)
      if (isIdle()) {
        clearInterval(timer)
        void restartNow()
      }
    }, 1_000)
  }
  return 'waiting'
}

// 백엔드가 오류로 갑자기 끝나도 Agent를 남기지 않는다(트리까지는 못 끝낸다).
process.on('exit', () => child?.kill())

// 백엔드가 꺼질 때 Agent도 끈다.
export async function stopAgent(): Promise<void> {
  stopping = true
  if (child) await kill(child)
  savePid(undefined)
}
