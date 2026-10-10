// 설정 화면 값. 모델 목록은 운영자가 AGENT_MODELS로 정하고, 화면은 그 안에서만 고른다.
// API 키는 Docker Agent env 파일(AGENT_ENV_FILE)에 쓴다. 키 값은 화면으로 돌려주지 않는다.

import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Settings } from '../src/lib/agentProtocol.ts'
import { config } from './config.ts'
import { getSetting, setSetting } from './store.ts'

// 저장된 값이 목록에서 빠졌으면 첫 번째 모델로 돌아간다. 목록이 비어 있으면 agent.yaml 모델을 쓴다(undefined).
export function currentModel(): string | undefined {
  const saved = getSetting('model')
  return saved && config.agentModels.includes(saved) ? saved : config.agentModels[0]
}

export function getSettings(): Settings {
  return {
    model: currentModel() ?? null,
    models: config.agentModels,
    apiKey: { editable: config.agentEnvFile !== '', set: apiKeySet() },
  }
}

// 목록에 없는 모델이면 false.
export function saveModel(model: string): boolean {
  if (!config.agentModels.includes(model)) return false
  setSetting('model', model)
  return true
}

// ---- API 키(계약 7장 ①) ----
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
