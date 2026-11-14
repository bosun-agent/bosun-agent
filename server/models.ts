// 입력창 모델 선택에 쓰는 전체 모델 목록. `docker-agent models --format json`이 키가 있는 provider의 모델을 준다
// (v1.148.0 실측: [{provider, model, default?}], OpenRouter 키만 있으면 380개 남짓, 0.6초).
// 이 명령은 --env-from-file을 받지 않아서 Agent env 파일의 API 키를 환경변수로 넘긴다. 결과는 잠시 기억해 둔다.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { config } from './config.ts'
import { validModelRef } from './settings.ts'

const CACHE_MS = 10 * 60_000
const TIMEOUT_MS = 20_000
// Docker Model Runner(로컬 모델)는 키 없이 늘 나오지만, BOSUN 설치에는 없다. 고르면 실행 때 실패하므로 뺀다.
const SKIP_PROVIDERS = new Set(['dmr'])

export interface Catalog {
  // `provider/model`. Docker Agent 실행 요청의 model 값으로 그대로 쓴다.
  models: string[]
  // unavailable: 실행 파일이 없어 목록을 받을 수 없음(AGENT_BIN 없음), failed: 실행했지만 실패
  error?: 'unavailable' | 'failed'
}

let cached: { at: number; catalog: Catalog } | null = null
let inflight: Promise<Catalog> | null = null

export function parseModelList(raw: string): string[] {
  const list = JSON.parse(raw) as unknown
  if (!Array.isArray(list)) return []
  const refs = list.flatMap((m) => {
    if (!m || typeof m !== 'object') return []
    const { provider, model } = m as Record<string, unknown>
    if (typeof provider !== 'string' || typeof model !== 'string' || SKIP_PROVIDERS.has(provider)) return []
    const ref = `${provider}/${model}`
    return validModelRef(ref) ? [ref] : []
  })
  return [...new Set(refs)].sort((a, b) => a.localeCompare(b))
}

// Agent env 파일에서 모델 provider 키만 고른다(이름이 _API_KEY로 끝나는 줄 + AGENT_KEY_NAME). Portainer 키는 넘기지 않는다.
async function providerKeys(): Promise<Record<string, string>> {
  if (!config.agentEnvFile) return {}
  let text: string
  try {
    text = await readFile(config.agentEnvFile, 'utf8')
  } catch {
    return {}
  }
  const keys: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const name = trimmed.slice(0, trimmed.indexOf('=')).trim()
    const value = trimmed.slice(trimmed.indexOf('=') + 1).trim()
    if (!value || name.startsWith('PORTAINER')) continue
    if (name === config.agentKeyName || /_API_KEY$/.test(name)) keys[name] = value
  }
  return keys
}

async function load(): Promise<Catalog> {
  if (config.modelCatalogFile) {
    try {
      return { models: parseModelList(await readFile(config.modelCatalogFile, 'utf8')) }
    } catch {
      return { models: [], error: 'failed' }
    }
  }
  if (!config.agentBin) return { models: [], error: 'unavailable' }
  const env = { ...process.env, ...(await providerKeys()), TELEMETRY_ENABLED: 'false' }
  return new Promise((resolve) => {
    execFile(
      config.agentBin,
      ['models', '--format', 'json'],
      { env, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          console.warn('[models] docker-agent models failed', err.message)
          resolve({ models: [], error: 'failed' })
          return
        }
        try {
          resolve({ models: parseModelList(stdout) })
        } catch {
          resolve({ models: [], error: 'failed' })
        }
      },
    )
  })
}

export async function modelCatalog(): Promise<Catalog> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.catalog
  inflight ??= load().then((catalog) => {
    // 실패는 기억하지 않는다. 다음에 다시 열면 다시 받는다.
    if (!catalog.error) cached = { at: Date.now(), catalog }
    inflight = null
    return catalog
  })
  return inflight
}

// API 키가 바뀌면 provider별 목록도 바뀐다.
export function clearModelCatalog(): void {
  cached = null
}
