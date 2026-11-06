// 설정 화면 값. 모델 목록은 운영자가 AGENT_MODELS로 정한 것과 관리자가 화면에서 더한 것을 합친 것이다.
// 화면은 그 안에서만 고른다. 더한 모델은 지울 수 있고 AGENT_MODELS 모델은 지울 수 없다.
// API 키는 Docker Agent env 파일(AGENT_ENV_FILE)에 쓴다. 키 값은 화면으로 돌려주지 않는다.

import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ApprovalMode, Settings } from '../src/lib/agentProtocol.ts'
import { config } from './config.ts'
import { getSetting, setSetting } from './store.ts'

function customModels(): string[] {
  try {
    const list = JSON.parse(getSetting('custom_models') ?? '[]') as unknown
    return Array.isArray(list) ? list.filter((m): m is string => typeof m === 'string') : []
  } catch {
    return []
  }
}

function allModels(): string[] {
  return [...new Set([...config.agentModels, ...customModels()])]
}

// 저장된 값이 목록에서 빠졌으면 첫 번째 모델로 돌아간다. 목록이 비어 있으면 agent.yaml 모델을 쓴다(undefined).
export function currentModel(): string | undefined {
  const saved = getSetting('model')
  const models = allModels()
  return saved && models.includes(saved) ? saved : models[0]
}

export function getSettings(): Settings {
  return {
    model: currentModel() ?? null,
    models: allModels(),
    customModels: customModels().filter((m) => !config.agentModels.includes(m)),
    apiKey: { editable: config.agentEnvFile !== '', set: apiKeySet() },
    approvalMode: approvalMode(),
    ...(config.portainerUrl ? { portainerUrl: config.portainerUrl } : {}),
  }
}

// ---- 승인 방식(YOLO, 10-28 회의 3번) ----
// ask: 매번 묻는다(기본). risky: 되돌릴 수 없거나 WEB이 모르는 작업만 묻고 나머지는 WEB이 대신 승인한다.
// never: 묻지 않고 모두 WEB이 대신 승인한다. 정책 훅·permissions.deny는 승인보다 먼저 돌아서 어느 방식에서도 그대로 막는다.
export const APPROVAL_MODES: readonly ApprovalMode[] = ['ask', 'risky', 'never']

export function approvalMode(): ApprovalMode {
  const saved = getSetting('approval_mode')
  return APPROVAL_MODES.includes(saved as ApprovalMode) ? (saved as ApprovalMode) : 'ask'
}

export function saveApprovalMode(mode: unknown): boolean {
  if (!APPROVAL_MODES.includes(mode as ApprovalMode)) return false
  setSetting('approval_mode', mode as string)
  return true
}

// 목록에 없는 모델이면 false.
export function saveModel(model: string): boolean {
  if (!allModels().includes(model)) return false
  setSetting('model', model)
  return true
}

// Docker Agent 실행 요청의 model 값: agent.yaml models 이름(`flash`) 또는 `provider/model`(`openrouter/deepseek/...`).
// 모델 이름에 쓰이는 글자만 받는다. 실제로 있는 모델인지는 Agent가 실행할 때 확인한다.
export function validModelRef(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 120 && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._:@+-]+)*$/.test(value)
}

export function addModel(model: string): void {
  if (allModels().includes(model)) return
  setSetting('custom_models', JSON.stringify([...customModels(), model]))
}

// AGENT_MODELS에 있는 모델은 지우지 않는다(false).
export function removeModel(model: string): boolean {
  if (config.agentModels.includes(model) || !customModels().includes(model)) return false
  setSetting('custom_models', JSON.stringify(customModels().filter((m) => m !== model)))
  return true
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

function isKeyLine(line: string): boolean {
  const trimmed = line.trim()
  return !trimmed.startsWith('#') && trimmed.split('=')[0].trim() === config.agentKeyName
}

function apiKeySet(): boolean {
  if (!config.agentEnvFile) return false
  return readEnvLines().some((line) => isKeyLine(line) && line.slice(line.indexOf('=') + 1).trim() !== '')
}

// 줄바꿈이나 공백이 들어가면 env 파일 줄이 깨진다. 따옴표는 Agent가 앞뒤에서 벗겨 내므로 받지 않는다.
export function validApiKey(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{8,512}$/.test(value) && !value.includes('"')
}

export function saveApiKey(apiKey: string): void {
  const lines = readEnvLines().filter((line) => !isKeyLine(line))
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop()
  lines.push(`${config.agentKeyName}=${apiKey}`)
  // 반쯤 쓴 파일을 Agent가 읽지 않게 옆 파일에 쓰고 바꿔 끼운다. 권한은 소유자만(600).
  const tmp = `${config.agentEnvFile}.tmp`
  writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o600 })
  renameSync(tmp, config.agentEnvFile)
  chmodSync(config.agentEnvFile, 0o600)
}
