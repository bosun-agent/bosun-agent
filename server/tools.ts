// 도구 호출 → 화면 문구. 처리 과정 줄과 승인 카드를 코드 템플릿으로 만든다(LLM 재요약 금지, 계약 4장).
// 도구는 Portainer MCP(mcp-portainer)의 docker_proxy와 EndpointList다(Agent 담당 agent.direct.yaml, 계약 7장).
// docker_proxy는 Docker Engine API 요청 하나라서 method와 path로 작업을 고른다.
// 도구 인자는 승인 카드에 허용 목록으로 고른 값만 싣고, 처리 과정에는 싣지 않는다(계약 5장 4항).

import type { ProposedAction, RiskReason } from '../src/lib/agentProtocol.ts'
import { maskText } from './mask.ts'

interface ToolAction {
  // 처리 과정 문구에 쓰는 작업 이름
  label: string
  // 승인 카드 제목. 없으면 공통 문구로 띄운다
  summary?: string
  target?: string
  // 승인 카드에 보여줄 값(이름 → 값). 요청 본문에서 사람이 확인해야 할 것만 고른다
  params?: Record<string, string>
  reasons?: RiskReason[]
}

const DESTRUCTIVE: RiskReason = { code: 'DESTRUCTIVE', message: '삭제하면 되돌릴 수 없어요.' }

const RESOURCES: Record<string, string> = {
  containers: '컨테이너',
  images: '이미지',
  networks: '네트워크',
  volumes: '볼륨',
}

// POST /containers/{id}/<동작>
const CONTAINER_ACTIONS: Record<string, string> = {
  start: '시작',
  stop: '중지',
  restart: '재시작',
  kill: '강제 종료',
  pause: '일시 중지',
  unpause: '재개',
  update: '설정 변경',
  rename: '이름 변경',
}

// POST /networks/{id}/<동작>
const NETWORK_ACTIONS: Record<string, string> = {
  connect: '컨테이너 연결',
  disconnect: '컨테이너 연결 해제',
}

// Portainer가 path의 %XX를 풀어서 Docker에 넘기므로 카드도 푼 값으로 보여준다(2026-10-11 실측).
// 64자리 ID는 docker CLI처럼 앞 12자리만 보여준다. 전체 값은 카드의 `요청`에 있다.
function decode(part: string): string {
  let value = part
  try {
    value = decodeURIComponent(part)
  } catch {
    // 잘못된 %XX는 그대로 둔다.
  }
  return /^[0-9a-f]{64}$/i.test(value) ? value.slice(0, 12) : value
}

// `/v1.45/containers/web/stop?t=10` → ['containers', 'web', 'stop']
function pathParts(path: string): string[] {
  const parts = path.split('?')[0].split('/').filter(Boolean).map(decode)
  if (/^v\d+(\.\d+)?$/.test(parts[0] ?? '')) parts.shift()
  return parts
}

// query_params와 body는 객체나 JSON 문자열로 올 수 있다.
function objectArg(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : []
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

const MAX_COMMAND = 1000

// `C:\data:/data:ro`처럼 Windows 경로에도 `:`가 들어간다.
function bindSource(bind: string): string {
  const end = /^[A-Za-z]:[\\/]/.test(bind) ? bind.indexOf(':', 2) : bind.indexOf(':')
  return end < 0 ? bind : bind.slice(0, end)
}

// POST /containers/create 본문에서 승인 전에 봐야 할 값을 고른다(2026-10-11 실측).
// 생성할 때 Cmd로 셸 명령을 넣거나 privileged·호스트 마운트를 켤 수 있어서, 카드가 이름만 보여주면 무엇을 승인하는지 알 수 없다.
// 환경변수는 값에 비밀이 들어갈 수 있으므로 이름만 보여준다.
function containerCreate(body: Record<string, unknown>): Pick<ToolAction, 'params' | 'reasons'> {
  const host = objectArg(body.HostConfig)
  const params: Record<string, string> = {}
  const reasons: RiskReason[] = []

  const image = str(body.Image)
  if (image) params.이미지 = image

  const command = [...strings(body.Entrypoint), ...strings(body.Cmd)].join(' ')
  if (command) {
    params.명령 = maskText(command.length > MAX_COMMAND ? `${command.slice(0, MAX_COMMAND)}…` : command)
    reasons.push({ code: 'COMMAND', message: '컨테이너가 시작될 때 이 명령이 실행돼요. 명령을 확인해주세요.' })
  }

  const ports = Object.entries(objectArg(host.PortBindings)).flatMap(([port, bindings]) =>
    (Array.isArray(bindings) ? bindings : []).map((b) => {
      const { HostIp, HostPort } = objectArg(b)
      return `${str(HostIp) ? `${HostIp}:` : ''}${str(HostPort) ?? '?'} → ${port}`
    }),
  )
  if (ports.length) params.포트 = ports.join(', ')

  const mounts: string[] = []
  const hostSources: string[] = []
  for (const bind of strings(host.Binds)) {
    mounts.push(bind)
    const source = bindSource(bind)
    if (source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source)) hostSources.push(source)
  }
  for (const m of Array.isArray(host.Mounts) ? host.Mounts : []) {
    const { Type, Source, Target } = objectArg(m)
    mounts.push(`${str(Source) ?? '(익명)'} → ${str(Target) ?? '?'}${str(Type) ? ` (${Type})` : ''}`)
    if (Type === 'bind' && str(Source)) hostSources.push(Source as string)
  }
  if (mounts.length) params.마운트 = mounts.join(', ')
  if (hostSources.some((s) => s.includes('docker.sock') || s === '/' || /^[A-Za-z]:[\\/]?$/.test(s))) {
    reasons.push({ code: 'HOST_TAKEOVER', message: '호스트 루트나 Docker 소켓을 연결하면 호스트 전체를 제어할 수 있어요.' })
  } else if (hostSources.length) {
    reasons.push({ code: 'HOST_MOUNT', message: `호스트 경로를 컨테이너에 연결해요: ${hostSources.join(', ')}` })
  }

  const elevated: string[] = []
  if (host.Privileged === true) elevated.push('privileged')
  const caps = strings(host.CapAdd)
  if (caps.length) elevated.push(`추가 권한 ${caps.join(', ')}`)
  if (Array.isArray(host.Devices) && host.Devices.length) elevated.push('호스트 장치')
  if (elevated.length) {
    params.권한 = elevated.join(', ')
    reasons.push({ code: 'PRIVILEGED', message: '컨테이너가 호스트에 가까운 권한을 가져요.' })
  }

  const shared = (['NetworkMode', 'PidMode', 'IpcMode', 'UsernsMode'] as const).filter((k) => host[k] === 'host')
  if (shared.length) {
    params.공유 = shared.map((k) => `${k}=host`).join(', ')
    reasons.push({ code: 'HOST_NAMESPACE', message: '컨테이너가 호스트의 네트워크·프로세스를 같이 써요.' })
  }

  const env = strings(body.Env).map((e) => e.split('=')[0])
  if (env.length) params.환경변수 = `${env.join(', ')} (값은 숨김)`

  return { params, reasons }
}

// 쿼리 값은 문자열("true")로 오기도 한다(2026-10-11 실측).
function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === 'true' || value === '1'
}

// 대상이 있으면 "컨테이너 web 중지", 없으면 "컨테이너 중지"
function titled(resource: string, target: string | undefined, verb: string): string {
  return target ? `${resource} ${target} ${verb}` : `${resource} ${verb}`
}

function dockerRequest(
  method: string,
  path: string,
  query: Record<string, unknown>,
  body: Record<string, unknown>,
): ToolAction {
  const [kind, ...rest] = pathParts(path)
  const resource = RESOURCES[kind]
  // GET은 permissions.allow라 보통 묻지 않는다. method를 빼고 부르면 승인 카드가 뜬다.
  if (method === 'GET' || method === 'HEAD') return { label: '조회', summary: resource ? `${resource} 조회` : '조회' }
  if (!resource) return { label: '변경' }

  if (method === 'DELETE') {
    // 이미지 이름에는 `/`가 들어간다(DELETE /images/library/nginx).
    const target = rest.join('/') || undefined
    const reasons = [DESTRUCTIVE]
    if (truthy(query.force)) {
      reasons.push(
        kind === 'images'
          ? { code: 'FORCE', message: '다른 태그나 컨테이너가 쓰고 있어도 지워요.' }
          : { code: 'FORCE', message: '실행 중이어도 강제로 멈추고 지워요.' },
      )
    }
    if (kind === 'containers' && truthy(query.v)) {
      reasons.push({ code: 'VOLUMES', message: '컨테이너에 딸린 익명 볼륨도 같이 지워져요.' })
    }
    return { label: '삭제', summary: titled(resource, target, '삭제'), target, reasons }
  }

  if (rest.length === 1 && rest[0] === 'create') {
    if (kind === 'images') {
      const image = str(query.fromImage)
      const tag = str(query.tag)
      const target = image && tag ? `${image}:${tag}` : image
      return { label: '이미지 다운로드', summary: titled('이미지', target, '다운로드'), target }
    }
    const target = str(query.name)
    const details = kind === 'containers' ? containerCreate(body) : {}
    return { label: '생성', summary: titled(resource, target, '생성'), target, ...details }
  }

  // 나머지는 `/<종류>/<식별값>/<동작>`. 이미지는 식별값에 `/`가 들어가므로 마지막 조각만 동작으로 본다.
  const action = rest.length > 1 ? rest.at(-1)! : undefined
  const target = (kind === 'images' ? rest.slice(0, action ? -1 : undefined).join('/') : rest[0]) || undefined
  const verb =
    (action && kind === 'containers' && CONTAINER_ACTIONS[action]) ||
    (action && kind === 'networks' && NETWORK_ACTIONS[action]) ||
    '변경'
  return { label: verb, summary: titled(resource, target, verb), target }
}

export function describeTool(tool: string, args: Record<string, unknown>): ToolAction | undefined {
  if (tool === 'EndpointList') return { label: '환경 목록 조회', summary: '환경 목록 조회' }
  if (tool !== 'docker_proxy') return undefined
  // mcp-portainer는 method를 빼면 GET으로 보낸다.
  const method = (str(args.method) ?? 'GET').toUpperCase()
  return dockerRequest(method, str(args.path) ?? '', objectArg(args.query_params), objectArg(args.body))
}

export function toolSummary(label: string | undefined, status: 'running' | 'succeeded' | 'failed'): string {
  if (!label) return { running: '도구 호출하는 중', succeeded: '실행 완료', failed: '실행 실패' }[status]
  return { running: `${label}하는 중`, succeeded: `${label} 완료`, failed: `${label} 실패` }[status]
}

export interface ApprovalCard {
  summary: string
  action: ProposedAction
  reasons: RiskReason[]
}

const MAX_BODY = 500

// names: 앞서 받은 조회 결과로 알아 둔 ID(앞 12자리) → 이름. 모델이 경로에 ID를 쓰면 카드에 이름을 보여준다.
export function approvalCard(
  tool: string,
  args: Record<string, unknown>,
  names: ReadonlyMap<string, string> = new Map(),
): ApprovalCard {
  const info = describeTool(tool, args)
  let target = info?.target
  let summary = info?.summary
  const name = target ? names.get(target.toLowerCase()) : undefined
  if (target && name) {
    summary = summary?.replace(target, name)
    target = `${name} (${target})`
  }
  const action: ProposedAction = { tool, ...(target ? { target } : {}) }
  const params: Record<string, string> = { ...info?.params }
  if (tool === 'docker_proxy') {
    const method = (str(args.method) ?? 'GET').toUpperCase()
    // force·v처럼 동작을 바꾸는 옵션이 쿼리로 온다. 컨테이너 생성 말고는 본문도 그대로 보여준다.
    const query = Object.entries(objectArg(args.query_params))
    if (query.length) params.옵션 = maskText(query.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', '))
    const body = objectArg(args.body)
    if (Object.keys(body).length && !info?.params) {
      const json = JSON.stringify(body)
      params.본문 = maskText(json.length > MAX_BODY ? `${json.slice(0, MAX_BODY)}…` : json)
    }
    if (typeof args.path === 'string') params.요청 = `${method} ${args.path}`
  }
  if (Object.keys(params).length > 0) action.params = params
  if (!summary) return { summary: '승인이 필요한 작업입니다.', action, reasons: [] }
  return { summary, action, reasons: info?.reasons ?? [] }
}

// ---- ID → 이름 ----
// 도구 결과에서 컨테이너·이미지 ID와 이름 짝을 찾는다. 모델이 select로 필드 이름을 바꾸므로 키 이름은 느슨하게 본다.
// 목록(`[{id, name}]`)과 상세 조회(`/containers/{id}/json` → `{name}`) 두 모양을 본다.

const HEX_ID = /^(?:sha256:)?([0-9a-f]{12,64})$/i
const MAX_NAMES = 2000

function idOf(obj: Record<string, unknown>): string | undefined {
  for (const [k, v] of Object.entries(obj)) {
    if (/^id$/i.test(k) && typeof v === 'string') {
      const m = HEX_ID.exec(v)
      if (m) return m[1].slice(0, 12).toLowerCase()
    }
  }
  return undefined
}

function nameOf(obj: Record<string, unknown>): string | undefined {
  for (const [k, v] of Object.entries(obj)) {
    if (!/^(names?|repotags|tags?)$/i.test(k)) continue
    const first = Array.isArray(v) ? v.find((x) => typeof x === 'string') : v
    if (typeof first === 'string' && first) return first.replace(/^\//, '')
  }
  return undefined
}

export function learnNames(
  names: Map<string, string>,
  tool: string,
  args: Record<string, unknown>,
  output: string,
): void {
  if (tool !== 'docker_proxy' || output.length > 2_000_000) return
  let data: unknown
  try {
    data = JSON.parse(output)
  } catch {
    return
  }
  const remember = (id: string, name: string) => {
    if (names.size >= MAX_NAMES) names.delete(names.keys().next().value!)
    names.set(id, name)
  }
  const items = Array.isArray(data) ? data : [data]
  for (const item of items.slice(0, 1000)) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const name = nameOf(obj)
    if (!name) continue
    const id = idOf(obj)
    if (id) remember(id, name)
  }
  // 상세 조회는 결과에 ID를 빼고 이름만 고르는 경우가 많아서 경로의 ID를 쓴다.
  if (!Array.isArray(data) && data && typeof data === 'object') {
    const [kind, id, action] = pathParts(str(args.path) ?? '')
    const name = nameOf(data as Record<string, unknown>)
    if (name && (kind === 'containers' || kind === 'images') && action === 'json' && id && HEX_ID.test(id)) {
      remember(id.slice(0, 12).toLowerCase(), name)
    }
  }
}
