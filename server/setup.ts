// 첫 실행 설정. 값은 사용자가 직접 발급받아 화면에 넣는다. WEB은 값을 만들어 내지 않는다.
//
// 넣는 값 세 개(모두 Docker Agent env 파일 = AGENT_ENV_FILE에 쓴다):
//   OPENROUTER_API_KEY  모델 열쇠. openrouter.ai → Keys에서 사용자가 만든다.
//   PORTAINER_URL       Agent가 붙는 Portainer 주소. 컨테이너 스택 안이면 https://portainer:9443.
//   PORTAINER_API_KEY   Portainer 열쇠. Portainer → My account → Access tokens에서 사용자가 만든다.
//
// Portainer 관리자 계정은 사용자가 Portainer 화면에서 직접 만든다(우리는 자격증명을 받지 않는다).
// 저장한 값은 Agent를 다시 시작해야 적용된다. 그래서 저장이 끝나면 Agent를 다시 시작하고 준비될 때까지 기다린다.
//
// 저장하기 전에 실제로 쓸 수 있는 값인지 확인한다(키 오타로 '설정됨'이 되는 것을 막는다):
//   OpenRouter: GET https://openrouter.ai/api/v1/key  → 401이면 잘못된 키
//   Portainer:  GET {url}/api/endpoints (X-API-Key)   → 401/403이면 잘못된 키, 200이면 Docker 환경 수를 본다
// docker_proxy는 endpoint 1번을 쓰므로 endpoint가 하나도 없으면 저장을 막고 Portainer에서 등록하라고 알려준다.

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { agentStatus, restartAgent } from './agentProcess.ts'
import * as agent from './agentClient.ts'
import { config } from './config.ts'
import { agentEnvIsSet, agentEnvValue, saveAgentEnvValues, validEnvValue } from './settings.ts'

// Portainer 주소로 받는 모양. 뒤에 경로가 붙는 것을 막는다.
const URL_SHAPE = /^https?:\/\/[A-Za-z0-9._~-]+(:\d{1,5})?\/?$/

export const PORTAINER_URL_NAME = 'PORTAINER_URL'
export const PORTAINER_API_KEY_NAME = 'PORTAINER_API_KEY'

export type SetupInput = {
  openrouterKey?: unknown
  portainerUrl?: unknown
  portainerApiKey?: unknown
}

export type SetupStatus = {
  // 값 세 개가 다 있으면 false. 화면은 이것으로 첫 설정 페이지를 띄울지 정한다.
  needsSetup: boolean
  // env 파일에 쓸 수 있는 상태인지(AGENT_ENV_FILE). false면 화면에서 저장할 수 없다.
  writable: boolean
  openrouter: { name: string; set: boolean }
  portainer: { urlName: string; urlSet: boolean; url: string | null; keySet: boolean }
  // 브라우저가 여는 Portainer 주소(WEB 환경변수 PORTAINER_URL). 컨테이너 설치 때 정하므로 화면에서 바꾸지 못한다.
  browserUrl: string | null
  agent: { state: string }
  // 화면 안내문에 쓰는 기본값. 컨테이너 스택이면 이 주소다.
  portainerUrlHint: string
}

export type SetupCheck = { ok: boolean; message: string }

export type SetupResult =
  | { ok: true; status: SetupStatus; restart: string; ready: boolean; checks: Record<string, SetupCheck> }
  | { ok: false; errors: Record<string, string> }

export type FieldErrors = Record<string, string>

function timeoutEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  const value = raw === undefined || raw === '' ? NaN : Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// 값을 보지 않고 있는지 없는지만 알려준다(설정 화면과 같은 규칙).
export function setupStatus(): SetupStatus {
  const portainerUrl = agentEnvValue(PORTAINER_URL_NAME)
  const openrouterSet = agentEnvIsSet(config.agentKeyName)
  const portainerKeySet = agentEnvIsSet(PORTAINER_API_KEY_NAME)
  const urlSet = portainerUrl !== null
  return {
    needsSetup: !(openrouterSet && portainerKeySet && urlSet),
    writable: config.agentEnvFile !== '',
    openrouter: { name: config.agentKeyName, set: openrouterSet },
    portainer: { urlName: PORTAINER_URL_NAME, urlSet, url: portainerUrl, keySet: portainerKeySet },
    browserUrl: config.portainerUrl || null,
    agent: { state: agentStatus().state },
    portainerUrlHint: process.env.PORTAINER_URL_INTERNAL || 'https://<Portainer 호스트>:9443',
  }
}

// ---- 바깥 서비스 확인 ----

type Probe = { status: number; body: string; tlsError?: string; error?: string }

// fetch를 쓰지 않는다: 자체 서명 인증서(컨테이너 스택의 Portainer)를 확인하려면 TLS 검증을 요청마다 끌 수 있어야 한다.
function probe(url: string, headers: Record<string, string>, verifyTls: boolean, timeoutMs: number): Promise<Probe> {
  return new Promise((resolve) => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      resolve({ status: 0, body: '', error: 'bad-url' })
      return
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(
      url,
      { method: 'GET', headers, ...(target.protocol === 'https:' ? { rejectUnauthorized: verifyTls } : {}) },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          if (body.length < 100_000) body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', (err: NodeJS.ErrnoException) => {
      const tls = ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']
      resolve({ status: 0, body: '', ...(tls.includes(err.code ?? '') ? { tlsError: err.code } : { error: err.code ?? err.message }) })
    })
    req.end()
  })
}

// OpenRouter 키 확인. 이 주소는 키가 있어야 답한다(없거나 틀리면 401).
export async function checkOpenRouterKey(key: string): Promise<SetupCheck> {
  const res = await probe('https://openrouter.ai/api/v1/key', { authorization: `Bearer ${key}` }, true, 10_000)
  if (res.status === 200) return { ok: true, message: 'OpenRouter 키를 확인했어요.' }
  if (res.status === 401) return { ok: false, message: 'OpenRouter가 이 키를 거부했어요(401). openrouter.ai → Keys에서 다시 복사해 주세요.' }
  if (res.status === 0) return { ok: false, message: `OpenRouter에 연결하지 못했어요(${res.error ?? res.tlsError}). 네트워크를 확인해 주세요.` }
  return { ok: false, message: `OpenRouter 확인 실패(HTTP ${res.status}). 잠시 뒤 다시 시도해 주세요.` }
}

export type PortainerCheck = SetupCheck & {
  endpoints: number
  tlsSkipped: boolean
  // 이 문제를 어느 입력 칸에 보여줄지. 화면이 엉뚱한 칸에 빨간 글씨를 띄우지 않게 한다.
  field: 'portainerUrl' | 'portainerApiKey'
}

// Portainer 키와 주소 확인. 자체 서명 인증서면 검증을 끄고 한 번 더 본다(컨테이너 스택 기본값).
export async function checkPortainerAccess(url: string, apiKey: string): Promise<PortainerCheck> {
  const first = await probe(`${url}/api/endpoints`, { 'x-api-key': apiKey }, true, 10_000)
  let res = first
  let tlsSkipped = false
  if (first.tlsError) {
    tlsSkipped = true
    res = await probe(`${url}/api/endpoints`, { 'x-api-key': apiKey }, false, 10_000)
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      endpoints: 0,
      tlsSkipped,
      field: 'portainerApiKey',
      message: `Portainer가 이 API 키를 거부했어요(HTTP ${res.status}). Portainer → My account → Access tokens에서 다시 만들어 주세요.`,
    }
  }
  if (res.status !== 200) {
    const why = res.status === 0 ? `연결하지 못했어요(${res.error ?? 'unknown'})` : `HTTP ${res.status}`
    return { ok: false, endpoints: 0, tlsSkipped, field: 'portainerUrl', message: `Portainer에 ${why}. 주소(${url})를 확인해 주세요.` }
  }
  let list: unknown
  try {
    list = JSON.parse(res.body)
  } catch {
    return { ok: false, endpoints: 0, tlsSkipped, field: 'portainerUrl', message: 'Portainer 응답을 읽지 못했어요. 주소가 Portainer인지 확인해 주세요.' }
  }
  const endpoints = Array.isArray(list) ? list.length : 0
  if (endpoints === 0) {
    return {
      ok: false,
      endpoints,
      tlsSkipped,
      field: 'portainerUrl',
      message: 'Portainer에 Docker 환경(endpoint)이 아직 없어요. Portainer 화면에서 Get Started(local)로 등록한 뒤 다시 시도해 주세요.',
    }
  }
  return { ok: true, endpoints, tlsSkipped, field: 'portainerUrl', message: `Portainer 연결됨 — Docker 환경 ${endpoints}개.` }
}

// ---- 저장 ----

// 보낸 값만 형식 검사 → 실제 확인(네트워크) → 저장 → Agent 재시작 → 준비 대기.
// 이미 들어 있는 값은 보내지 않아도 된다(다시 입력하게 만들지 않는다).
export async function applySetup(input: SetupInput): Promise<SetupResult> {
  const errors: FieldErrors = {}
  const values: Record<string, string> = {}
  const checks: Record<string, SetupCheck> = {}

  if (input.openrouterKey !== undefined) {
    const value = typeof input.openrouterKey === 'string' ? input.openrouterKey.trim() : input.openrouterKey
    if (!validEnvValue(value)) errors.openrouterKey = '키 형식이 올바르지 않아요(공백·줄바꿈 없이 8자 이상).'
    else values[config.agentKeyName] = value
  }
  if (input.portainerUrl !== undefined) {
    const value = (typeof input.portainerUrl === 'string' ? input.portainerUrl.trim() : '').replace(/\/+$/, '')
    if (!validEnvValue(value) || !URL_SHAPE.test(value)) errors.portainerUrl = '주소는 http:// 또는 https:// 로 시작하는 호스트:포트 형식이에요(예: https://portainer:9443).'
    else values[PORTAINER_URL_NAME] = value
  }
  if (input.portainerApiKey !== undefined) {
    const value = typeof input.portainerApiKey === 'string' ? input.portainerApiKey.trim() : input.portainerApiKey
    if (!validEnvValue(value)) errors.portainerApiKey = '키 형식이 올바르지 않아요(공백·줄바꿈 없이 8자 이상).'
    else values[PORTAINER_API_KEY_NAME] = value
  }
  if (Object.keys(values).length === 0 && Object.keys(errors).length === 0) {
    return { ok: false, errors: { form: '저장할 값이 없어요.' } }
  }
  if (!config.agentEnvFile) {
    return { ok: false, errors: { form: 'AGENT_ENV_FILE이 없어 값을 저장할 수 없어요. 설치할 때 Agent env 파일 경로를 넣어주세요.' } }
  }

  // 확인은 새로 넣은 값이 있을 때만 한다. 형식이 틀린 항목이 있으면 확인하지 않는다.
  if (Object.keys(errors).length === 0) {
    if (values[config.agentKeyName] !== undefined) {
      const check = await checkOpenRouterKey(values[config.agentKeyName])
      checks.openrouterKey = check
      if (!check.ok) errors.openrouterKey = check.message
    }
    const url = values[PORTAINER_URL_NAME] ?? agentEnvValue(PORTAINER_URL_NAME)
    const key = values[PORTAINER_API_KEY_NAME] ?? agentEnvValue(PORTAINER_API_KEY_NAME)
    if (url !== null && key !== null && (values[PORTAINER_URL_NAME] !== undefined || values[PORTAINER_API_KEY_NAME] !== undefined)) {
      const check = await checkPortainerAccess(url, key)
      checks.portainer = check
      if (!check.ok) {
        // 이번에 넣은 칸에 보여준다. 둘 다 넣었으면 문제가 난 쪽에 보여준다.
        const urlNew = values[PORTAINER_URL_NAME] !== undefined
        const keyNew = values[PORTAINER_API_KEY_NAME] !== undefined
        const target = check.field === 'portainerApiKey' ? (keyNew ? 'portainerApiKey' : 'portainerUrl') : urlNew ? 'portainerUrl' : 'portainerApiKey'
        errors[target] = check.message
      }
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }

  saveAgentEnvValues(values)
  // 값은 로그에 남기지 않는다. 무엇을 넣었는지만 남긴다.
  console.info(`[setup] stored ${Object.keys(values).join(', ')}`)

  const restart = restartAgent()
  const ready = restart === 'manual' ? false : await waitForAgent()
  console.info(`[setup] agent restart: ${restart}, ready: ${ready}`)
  return { ok: true, status: setupStatus(), restart, ready, checks }
}

// Agent가 다시 시작해 요청을 받을 때까지 기다린다. 화면은 이 값으로 "준비 중" 안내를 정한다.
async function waitForAgent(timeoutMs = timeoutEnv('SETUP_AGENT_WAIT_MS', 30_000)): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const health = await agent.health().catch(() => null)
    if (health?.status === 'ok') return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}
