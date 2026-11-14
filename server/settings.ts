// 설정 화면 값. 모델은 입력창에서 고른다: 권장(AGENT_MODELS)이나 `docker-agent models`의 전체 목록(server/models.ts).
// API 키는 Docker Agent env 파일(AGENT_ENV_FILE)에 쓴다. 키 값은 화면으로 돌려주지 않는다.

import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { READ_CHOICES, type AgentMode, type ApprovalMode, type ReadChoice, type Settings } from '../src/lib/agentProtocol.ts'
import { config } from './config.ts'
import { getSetting, setSetting } from './store.ts'

// 저장할 때 목록에 있는지 확인했으므로 저장된 값을 그대로 쓴다. 없으면 권장 첫 번째, 그것도 없으면 agent.yaml 모델(undefined).
// (예전 설정 화면에서 더한 custom_models는 이제 쓰지 않는다. 고른 모델이 그중 하나였다면 그대로 남는다.)
export function currentModel(): string | undefined {
  const saved = getSetting('model')
  return saved && validModelRef(saved) ? saved : config.agentModels[0]
}

export function getSettings(): Settings {
  return {
    model: currentModel() ?? null,
    models: config.agentModels,
    apiKey: { editable: config.agentEnvFile !== '', set: apiKeySet() },
    approvalMode: approvalMode(),
    ...(agentModesEnabled() ? { agentMode: currentAgentName() as AgentMode } : {}),
    autoReads: autoReads(),
    ...(config.portainerUrl ? { portainerUrl: config.portainerUrl } : {}),
  }
}

// ---- 승인 방식(YOLO) ----
// ask: 매번 묻는다(기본). never: 묻지 않고 삭제까지 모두 WEB이 대신 승인한다(YOLO). 정책 훅·permissions.deny는 승인보다 먼저 돌아서 어느 방식에서도 그대로 막는다.
export const APPROVAL_MODES: readonly ApprovalMode[] = ['ask', 'never']

export function approvalMode(): ApprovalMode {
  const saved = getSetting('approval_mode')
  return APPROVAL_MODES.includes(saved as ApprovalMode) ? (saved as ApprovalMode) : 'ask'
}

export function saveApprovalMode(mode: unknown): boolean {
  if (!APPROVAL_MODES.includes(mode as ApprovalMode)) return false
  setSetting('approval_mode', mode as string)
  return true
}

// ---- 초보자용·숙련자용 Agent ----
// AGENT_CONFIG가 두 Agent가 든 폴더일 때 AGENT_NAME이 beginner나 expert다. 파일 하나인 설치에서는 고를 수 없다.
export const AGENT_MODES: readonly AgentMode[] = ['beginner', 'expert']

function agentModesEnabled(): boolean {
  return AGENT_MODES.includes(config.agentName as AgentMode)
}

// 실행 요청 주소에 넣는 Agent 이름. Docker Agent는 대화마다 처음 만든 Agent를 계속 쓰므로 새 대화부터 바뀐다.
export function currentAgentName(): string {
  const saved = getSetting('agent_mode')
  return agentModesEnabled() && AGENT_MODES.includes(saved as AgentMode) ? (saved as string) : config.agentName
}

export function saveAgentMode(mode: unknown): boolean {
  if (!agentModesEnabled() || !AGENT_MODES.includes(mode as AgentMode)) return false
  setSetting('agent_mode', mode as string)
  return true
}

// ---- 승인 없이 바로 실행할 조회 ----

export function autoReads(): ReadChoice[] {
  try {
    const list = JSON.parse(getSetting('auto_reads') ?? '[]') as unknown
    return Array.isArray(list) ? READ_CHOICES.filter((c) => list.includes(c)) : []
  } catch {
    return []
  }
}

export function validAutoReads(value: unknown): value is ReadChoice[] {
  return Array.isArray(value) && value.every((v) => READ_CHOICES.includes(v as ReadChoice))
}

export function saveAutoReads(reads: ReadChoice[]): void {
  setSetting('auto_reads', JSON.stringify(reads))
}

// 권장 모델이나 전체 목록(catalog)에 없는 모델이면 false.
export function saveModel(model: string, catalog: readonly string[] = []): boolean {
  if (!config.agentModels.includes(model) && !catalog.includes(model)) return false
  setSetting('model', model)
  return true
}

// Docker Agent 실행 요청의 model 값: agent.yaml models 이름(`flash`) 또는 `provider/model`(`openrouter/deepseek/...`).
// 모델 이름에 쓰이는 글자만 받는다. 실제로 있는 모델인지는 Agent가 실행할 때 확인한다.
export function validModelRef(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 120 && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._:@+-]+)*$/.test(value)
}

// ---- API 키 ----
// Docker Agent의 env 파일 형식(v1.148.0 pkg/environment/env_files.go): 줄마다 KEY=VALUE, 빈 줄과 #으로 시작하는 줄은 건너뛴다.
// 같은 파일에 Portainer 주소·키도 있으므로 바꿀 키 줄만 고치고 나머지 줄은 그대로 둔다.

function readEnvLines(): string[] {
  try {
    return readFileSync(config.agentEnvFile, 'utf8').split(/\r?\n/)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

function apiKeySet(): boolean {
  return agentEnvIsSet(config.agentKeyName)
}

// 줄바꿈이나 공백이 들어가면 env 파일 줄이 깨진다. 따옴표는 Agent가 앞뒤에서 벗겨 내므로 받지 않는다.
// 키뿐 아니라 주소·토큰도 같은 규칙으로 본다(인쇄 가능한 ASCII, 공백 없음).
export function validEnvValue(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{8,512}$/.test(value) && !value.includes('"')
}

export function validApiKey(value: unknown): value is string {
  return validEnvValue(value)
}

// ---- Agent env 파일의 여러 값(첫 실행 설정 화면, server/setup.ts) ----
// 값은 화면으로 돌려주지 않는다(설정 화면과 같은 규칙). 있는지 없는지만 알려준다.

export function agentEnvValue(name: string): string | null {
  if (!config.agentEnvFile) return null
  const line = readEnvLines().find((l) => {
    const trimmed = l.trim()
    return !trimmed.startsWith('#') && trimmed.split('=')[0].trim() === name
  })
  if (line === undefined) return null
  const value = line.slice(line.indexOf('=') + 1).trim()
  return value === '' ? null : value
}

export function agentEnvIsSet(name: string): boolean {
  return agentEnvValue(name) !== null
}

// 이름만 있고 값이 빈 줄(예: `PORTAINER_API_KEY=`). docker-agent는 이런 줄을 "값이 있는 항목"으로 읽어
// (pkg/environment/env_files.go) 공급자 체인 1순위에서 **빈 문자열**을 그대로 쓴다 → MCP 도구까지 빈 값이 가고
// Portainer는 "A valid authorization token is missing"을 돌려준다. 조용한 실패라 따로 찾아낸다.
export function agentEnvBlankKeys(names: readonly string[]): string[] {
  if (!config.agentEnvFile) return []
  const blank = new Set<string>()
  for (const line of readEnvLines()) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const name = trimmed.slice(0, eq).trim()
    if (names.includes(name) && trimmed.slice(eq + 1).trim() === '') blank.add(name)
  }
  return [...blank]
}

// 보낸 값을 한 번에 쓴다. 다른 줄(주석·다른 키)은 그대로 두고, 같은 이름의 줄은 지우고 새로 붙인다.
// **빈 값은 줄을 만들지 않는다**: docker-agent의 env 파일 파서는 `KEY=`(빈 값)를 "값이 있는 항목"으로
// 읽고(`pkg/environment/env_files.go` ReadEnvFile), 공급자 체인은 첫 번째로 찾은 값을 그대로 쓴다
// (`pkg/environment/multi.go` MultiProvider.Get). 그래서 빈 줄이 남아 있으면 컨테이너 환경변수보다
// 우선해서 **빈 문자열이 MCP 도구까지 전달**되고, Portainer는 `A valid authorization token is missing`을
// 돌려준다(값이 아예 없으면 `${env.X}`가 치환되지 않아 다른 오류가 난다 — 조용한 실패를 만드는 쪽이 빈 줄이다).
export function saveAgentEnvValues(values: Record<string, string>): void {
  if (!config.agentEnvFile) throw new Error('AGENT_ENV_FILE이 없어요. Agent env 파일 경로를 넣어주세요.')
  const names = new Set(Object.keys(values))
  const lines = readEnvLines().filter((line) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) return true
    return !names.has(trimmed.split('=')[0].trim())
  })
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop()
  for (const [name, value] of Object.entries(values)) {
    if (value === '') continue
    lines.push(`${name}=${value}`)
  }
  const tmp = `${config.agentEnvFile}.tmp`
  writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o600 })
  renameSync(tmp, config.agentEnvFile)
  chmodSync(config.agentEnvFile, 0o600)
}

export function saveApiKey(apiKey: string): void {
  saveAgentEnvValues({ [config.agentKeyName]: apiKey })
}

// 값이 빈 줄을 지운다. 빈 줄은 "없음"이 아니라 "빈 문자열"로 전달되어(위 설명) 조용히 도구를 망가뜨린다.
// 저장할 때마다 세 이름을 청소해 두면, 컨테이너 환경변수로 넘어가거나 최소한 "값 없음"으로 보인다.
export function pruneBlankAgentEnvKeys(names: readonly string[]): string[] {
  const blank = agentEnvBlankKeys(names)
  if (blank.length === 0 || !config.agentEnvFile) return []
  const drop = new Set(blank)
  const lines = readEnvLines().filter((line) => {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return true
    const eq = trimmed.indexOf('=')
    if (eq < 0) return true
    return !(drop.has(trimmed.slice(0, eq).trim()) && trimmed.slice(eq + 1).trim() === '')
  })
  const tmp = `${config.agentEnvFile}.tmp`
  writeFileSync(tmp, `${lines.join('\n')}`, { mode: 0o600 })
  renameSync(tmp, config.agentEnvFile)
  chmodSync(config.agentEnvFile, 0o600)
  return blank
}
