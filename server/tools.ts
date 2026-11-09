// 도구 호출 → 화면 문구. 처리 과정 줄과 승인 카드를 코드 템플릿으로 만든다(LLM 재요약 금지).
// 도구는 Portainer MCP(mcp-portainer)의 docker_proxy, EndpointList, 스택 도구(Stack*)다(저장소 agent 브랜치의 설정).
// 표에 없는 도구는 "확인할 수 없는 작업" 카드로 띄운다.
// docker_proxy는 Docker Engine API 요청 하나라서 method와 path로 작업을 고른다.
// 도구 인자는 승인 카드에 허용 목록으로 고른 값만 싣고, 처리 과정에는 싣지 않는다.

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ProposedAction, ReadChoice, RiskLevel, RiskReason } from '../src/lib/agentProtocol.ts'
import type { HookExplanation } from './agentClient.ts'
import { maskText } from './mask.ts'

interface ToolAction {
  // 처리 과정 문구에 쓰는 작업 이름
  label: string
  // 승인 카드 제목. 없으면 "확인할 수 없는 작업" 카드로 띄운다
  summary?: string
  target?: string
  // 승인 카드에 보여줄 값(이름 → 값). 요청 본문에서 사람이 확인해야 할 것만 고른다
  params?: Record<string, string>
  reasons?: RiskReason[]
  // 카드 맨 위 위험도 표시
  risk?: RiskLevel
}

const DESTRUCTIVE: RiskReason = { code: 'DESTRUCTIVE', message: '삭제하면 되돌릴 수 없어요.' }

const IRREVERSIBLE: RiskLevel = { level: 'high', label: '되돌릴 수 없음' }
const UNKNOWN_RISK: RiskLevel = { level: 'unknown', label: '확인 필요' }

// 컨테이너 동작 → 위험도. 다시 시작할 수 있는 동작은 medium, 실행만 하는 동작은 low다.
const CONTAINER_RISKS: Record<string, RiskLevel> = {
  start: { level: 'low', label: '실행' },
  unpause: { level: 'low', label: '실행' },
  restart: { level: 'medium', label: '잠깐 끊김' },
  stop: { level: 'medium', label: '서비스 멈춤' },
  kill: { level: 'medium', label: '서비스 멈춤' },
  pause: { level: 'medium', label: '서비스 멈춤' },
  update: { level: 'medium', label: '설정 바뀜' },
  rename: { level: 'medium', label: '설정 바뀜' },
}

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

// 승인하면 어떻게 되는지(Docker 동작 기준). 승인 카드에 사유와 같이 보여준다(code EFFECT, 화면은 → 로 표시).
const effect = (message: string): RiskReason => ({ code: 'EFFECT', message })

const CONTAINER_EFFECTS: Record<string, string> = {
  start: '멈춰 있던 컨테이너가 실행돼요.',
  stop: '컨테이너 안 프로그램이 종료돼요. 서비스가 멈추고, 나중에 다시 시작할 수 있어요.',
  restart: '컨테이너를 멈췄다가 다시 실행해요. 잠깐 서비스가 끊겨요.',
  kill: '컨테이너를 정리할 틈 없이 바로 끝내요. 저장 안 된 작업이 사라질 수 있어요.',
  pause: '컨테이너 안 프로그램을 잠시 얼려요. 재개하면 이어서 돌아요.',
  unpause: '얼려 둔 컨테이너를 다시 돌려요.',
  update: '실행 중인 컨테이너의 자원 제한이나 재시작 정책이 바뀌어요.',
  rename: '컨테이너 이름이 바뀌어요. 이름으로 찾던 곳이 있으면 같이 고쳐야 해요.',
}

const DELETE_EFFECTS: Record<string, string> = {
  containers: '컨테이너와 그 안에서 바뀐 파일이 지워져요. 이름 있는 볼륨은 남아요.',
  images: '이미지가 지워져요. 다시 쓰려면 다시 받아야 해요.',
  networks: '네트워크가 지워져요. 연결된 컨테이너가 있으면 지워지지 않아요.',
  volumes: '볼륨과 그 안의 데이터가 지워져요.',
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
function containerCreate(body: Record<string, unknown>): Pick<ToolAction, 'params' | 'reasons' | 'risk'> {
  const host = objectArg(body.HostConfig)
  const params: Record<string, string> = {}
  const reasons: RiskReason[] = []

  const image = str(body.Image)
  if (image) params.이미지 = image

  const command = [...strings(body.Entrypoint), ...strings(body.Cmd)].join(' ')
  if (command) {
    params.명령 = maskText(command.length > MAX_COMMAND ? `${command.slice(0, MAX_COMMAND)}…` : command)
    // 처음 보는 사람도 판단할 수 있게 기준을 같이 준다. 대부분은 이미지의 기본 명령을 그대로 옮긴 것이다(2026-10-28 실측).
    reasons.push({
      code: 'COMMAND',
      message: '컨테이너가 시작될 때 이 명령이 실행돼요. 보통은 이미지에 정해진 기본 명령이에요. 모르는 명령이 보이면 거부해주세요.',
    })
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

  const hostRisk = reasons.some((r) => ['HOST_TAKEOVER', 'PRIVILEGED', 'HOST_NAMESPACE'].includes(r.code))
  const risk: RiskLevel = hostRisk ? { level: 'high', label: '호스트까지 영향' } : { level: 'low', label: '새로 만듦' }
  return { params, reasons, risk }
}

// 쿼리 값은 문자열("true")로 오기도 한다(2026-10-11 실측). Docker는 "", 0, no, false, none만
// 거짓으로 읽고 나머지("y", "2" 등)는 모두 참으로 읽는다(httputils.BoolValue). 같은 기준으로 판단한다.
function truthy(value: unknown): boolean {
  if (value === undefined || value === null) return false
  const s = (typeof value === 'string' ? value : JSON.stringify(value)).trim().toLowerCase()
  return !['', '0', 'no', 'false', 'none'].includes(s)
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
  if (method === 'GET' || method === 'HEAD') return { label: '조회', summary: resource ? `${resource} 조회` : '조회', risk: { level: 'low', label: '조회' } }
  if (!resource) return { label: '변경' }

  if (method === 'DELETE') {
    // 이미지 이름에는 `/`가 들어간다(DELETE /images/library/nginx).
    const target = rest.join('/') || undefined
    const reasons = [effect(DELETE_EFFECTS[kind]), DESTRUCTIVE]
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
    return { label: '삭제', summary: titled(resource, target, '삭제'), target, reasons, risk: IRREVERSIBLE }
  }

  if (rest.length === 1 && rest[0] === 'create') {
    if (kind === 'images') {
      const image = str(query.fromImage)
      const tag = str(query.tag)
      const target = image && tag ? `${image}:${tag}` : image
      return {
        label: '이미지 다운로드',
        summary: titled('이미지', target, '다운로드'),
        target,
        reasons: [effect('레지스트리에서 이미지를 받아 이 서버에 저장해요. 디스크 공간을 써요.')],
        risk: { level: 'low', label: '새로 받음' },
      }
    }
    const target = str(query.name)
    if (kind === 'containers') {
      const details = containerCreate(body)
      return {
        label: '생성',
        summary: titled(resource, target, '생성'),
        target,
        params: details.params,
        reasons: [effect('새 컨테이너를 만들기만 해요. 실행은 시작을 따로 승인해야 해요.'), ...(details.reasons ?? [])],
        risk: details.risk,
      }
    }
    return { label: '생성', summary: titled(resource, target, '생성'), target, risk: { level: 'low', label: '새로 만듦' } }
  }

  // 나머지는 `/<종류>/<식별값>/<동작>`. 이미지는 식별값에 `/`가 들어가므로 마지막 조각만 동작으로 본다.
  const action = rest.length > 1 ? rest.at(-1)! : undefined
  const target = (kind === 'images' ? rest.slice(0, action ? -1 : undefined).join('/') : rest[0]) || undefined
  const verb =
    (action && kind === 'containers' && CONTAINER_ACTIONS[action]) ||
    (action && kind === 'networks' && NETWORK_ACTIONS[action]) ||
    '변경'
  const about = action && kind === 'containers' ? CONTAINER_EFFECTS[action] : undefined
  const risk =
    (action && kind === 'containers' && CONTAINER_RISKS[action]) ||
    (action && kind === 'networks' && NETWORK_ACTIONS[action] ? { level: 'medium' as const, label: '연결 바뀜' } : UNKNOWN_RISK)
  return { label: verb, summary: titled(resource, target, verb), target, ...(about ? { reasons: [effect(about)] } : {}), risk }
}

export function describeTool(
  tool: string,
  args: Record<string, unknown>,
  stacks: ReadonlyMap<string, StackInfo> = new Map(),
): ToolAction | undefined {
  if (tool === 'EndpointList') return { label: '환경 목록 조회', summary: '환경 목록 조회' }
  if (tool.startsWith('Stack')) return stackAction(tool, args, stacks)
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
  risk?: RiskLevel
}

// WEB이 문구 표를 갖고 있지 않은 도구(새 MCP, 스택 도구 등)의 카드. 무엇을 하는지 설명할 수 없으므로
// 판단 기준을 주고, 인자는 값 없이 이름만 보여준다. 값에는 비밀(환경변수 등)이 들어 있을 수 있다.
const UNKNOWN_TOOL: RiskReason = {
  code: 'UNKNOWN',
  message: 'BOSUN이 아직 설명할 수 없는 도구예요. 무엇을 하는지 확실하지 않으면 거부해주세요.',
}

const MAX_BODY = 500

// names: 앞서 받은 조회 결과로 알아 둔 ID(앞 12자리) → 이름. 모델이 경로에 ID를 쓰면 카드에 이름을 보여준다.
export function approvalCard(
  tool: string,
  args: Record<string, unknown>,
  names: ReadonlyMap<string, string> = new Map(),
  stacks: ReadonlyMap<string, StackInfo> = new Map(),
): ApprovalCard {
  const info = describeTool(tool, args, stacks)
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
  if (!info) {
    const keys = Object.keys(args)
    if (keys.length) params.인자 = keys.join(', ') + ' (값은 숨김)'
  }
  if (Object.keys(params).length > 0) action.params = params
  if (!summary) return { summary: '어떤 작업인지 확인할 수 없어요.', action, reasons: [UNKNOWN_TOOL], risk: UNKNOWN_RISK }
  return { summary, action, reasons: info?.reasons ?? [], ...(info?.risk ? { risk: info.risk } : {}) }
}

// ---- 승인 카드 설명 훅 ----
// 훅은 실제로 실행될 요청만 보고 정해진 문장을 만든다. 있으면 WEB 표의 효과 문구 대신 쓰고, 위험도도 훅 기준으로 맞춘다.

const BLAST_LABEL: Record<string, string> = { low: '영향 적음', medium: '영향 있음', high: '영향 큼' }
const MAX_HOOK_REASON = 1500

export function withHookExplanation(card: ApprovalCard, hook: HookExplanation | undefined): ApprovalCard {
  const level = hook?.blast_radius && BLAST_LABEL[hook.blast_radius] ? (hook.blast_radius as RiskLevel['level']) : undefined
  const reason = hook?.reason?.trim()
  const next: ApprovalCard = { ...card }
  if (reason) {
    const text = maskText(reason.length > MAX_HOOK_REASON ? `${reason.slice(0, MAX_HOOK_REASON)}…` : reason)
    // 훅이 설명한 도구면 "설명할 수 없는 도구" 경고는 뺀다.
    next.reasons = [effect(text), ...card.reasons.filter((r) => r.code !== 'EFFECT' && (r.code !== 'UNKNOWN' || !level))]
  }
  if (level && card.risk?.level !== level) next.risk = { level, label: BLAST_LABEL[level] }
  if (hook?.category === 'backup-now') next.summary = '지금 볼륨 백업'
  return next
}

// 훅 설명의 "'이름' 컨테이너(짧은 ID)"에서 이름을 배운다. 백엔드를 다시 켠 뒤 모델이 기억한 ID로 바로 불러도 카드에 이름이 나온다.
export function learnHookName(names: Map<string, string>, hook: HookExplanation | undefined): void {
  for (const m of hook?.reason?.matchAll(/'([^']+)' 컨테이너\(([0-9a-f]{12})\)/g) ?? []) names.set(m[2], m[1])
}

// ---- 승인 없이 바로 실행할 수 있는 조회 ----
// 설정에서 고른 조회만 WEB이 대신 승인한다. 표에 정확히 맞는 GET만 해당한다.

const REF = '[A-Za-z0-9][A-Za-z0-9_.-]*'
const READ_PATHS: [RegExp, ReadChoice][] = [
  [new RegExp(`^/containers/${REF}/logs$`), 'logs'],
  [new RegExp(`^/containers/${REF}/json$`), 'container_inspect'],
  [new RegExp(`^/containers/${REF}/top$`), 'top'],
  [/^\/images\/[A-Za-z0-9][A-Za-z0-9_./:@-]*\/(?:json|history)$/, 'image_inspect'],
  [new RegExp(`^/volumes/${REF}$`), 'volume_inspect'],
]

export function readChoice(tool: string, args: Record<string, unknown>): ReadChoice | undefined {
  if (tool === 'StackFileInspect') return 'stack_file'
  if (tool !== 'docker_proxy' || (str(args.method) ?? 'GET').toUpperCase() !== 'GET') return undefined
  const path = (str(args.path) ?? '').replace(/^\/v\d+(\.\d+)?(?=\/)/, '')
  if (/[?#%\\]|\.\.|\/\//.test(path)) return undefined
  const choice = READ_PATHS.find(([re]) => re.test(path))?.[1]
  // 끝나지 않는 로그 받기는 조회로 치지 않는다.
  return choice === 'logs' && truthy(objectArg(args.query_params).follow) ? undefined : choice
}

// ---- ID → 이름 ----
// 도구 결과에서 컨테이너·이미지 ID와 이름 짝을 찾는다. 모델이 select로 필드 이름을 바꾸므로 키 이름은 느슨하게 본다.
// 목록(`[{id, name}]`)과 상세 조회(`/containers/{id}/json` → `{name}`) 두 모양을 본다.

const HEX_ID = /^(?:sha256:)?([0-9a-f]{12,64})$/i
const MAX_NAMES = 2000

// 비교용으로 맞춘 이름·ID. ID는 앞 12자리, 태그 없는 이미지는 `:latest`를 붙인다(Docker와 같은 기본값).
function normalized(kind: string, value: string): string {
  const v = value.trim().replace(/^\//, '').toLowerCase()
  const id = HEX_ID.exec(v)
  if (id) return id[1].slice(0, 12)
  if (kind === 'images' && !v.split('/').at(-1)!.includes(':')) return `${v}:latest`
  return v
}

// 이 이름으로 알아 둔 ID들. 이름 대신 ID로 왔으면 그 ID 하나다.
function idsFor(names: ReadonlyMap<string, string>, kind: string, target: string): string[] {
  const key = normalized(kind, target)
  if (HEX_ID.test(key)) return [key]
  return [...names].filter(([, name]) => normalized(kind, name) === key).map(([id]) => id)
}

// 두 요청이 같은 대상을 바꾸는지 비교하는 키. `환경/종류/이름 또는 ID`이고, 이름과 ID를 둘 다 알면 둘 다 넣는다.
// 환경과 종류를 넣어서 다른 환경의 web이나 볼륨 web을 컨테이너 web과 같은 대상으로 보지 않는다.
export function targetKeys(
  tool: string,
  args: Record<string, unknown>,
  names: ReadonlyMap<string, string>,
  stacks: ReadonlyMap<string, StackInfo> = new Map(),
): string[] {
  if (tool.startsWith('Stack')) return stackKeys(tool, args, stacks)
  if (tool !== 'docker_proxy') return []
  const kind = pathParts(str(args.path) ?? '')[0]
  const target = describeTool(tool, args)?.target
  if (!RESOURCES[kind] || !target) return []
  const env = String(args.environment_id ?? '')
  const values = new Set([normalized(kind, target)])
  for (const id of idsFor(names, kind, target)) {
    values.add(id)
    const name = names.get(id)
    if (name) values.add(normalized(kind, name))
  }
  return [...values].map((v) => `${env}/${kind}/${v}`)
}

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
  stacks: Map<string, StackInfo> = new Map(),
): void {
  if (output.length > 2_000_000) return
  if (tool.startsWith('Stack')) return learnStacks(stacks, tool, args, output)
  if (tool !== 'docker_proxy') return
  // 이름 변경·삭제가 성공하면 표를 고친다. 안 고치면 다른 대화의 카드가 옛 이름을 보여준다. 둘 다 결과 본문이 비어 있다.
  const method = (str(args.method) ?? 'GET').toUpperCase()
  const [kind, pathId, action] = pathParts(str(args.path) ?? '')
  const target = describeTool(tool, args)?.target
  if (target && (kind === 'containers' || kind === 'images') && method !== 'GET') {
    if (method === 'DELETE') {
      for (const id of idsFor(names, kind, target)) names.delete(id)
      return
    }
    const renamed = str(objectArg(args.query_params).name)?.replace(/^\//, '')
    if (kind === 'containers' && action === 'rename' && renamed) {
      for (const id of idsFor(names, kind, target)) names.set(id, renamed)
      return
    }
  }
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
  if (!Array.isArray(data) && data && typeof data === 'object') {
    // 상세 조회는 결과에 ID를 빼고 이름만 고르는 경우가 많아서 경로의 ID를 쓴다.
    const name = nameOf(data as Record<string, unknown>)
    if (name && (kind === 'containers' || kind === 'images') && action === 'json' && pathId && HEX_ID.test(pathId)) {
      remember(pathId.slice(0, 12).toLowerCase(), name)
    }
    // 생성 결과에는 ID만 온다. 이름은 요청 쿼리에 있다(바로 이어지는 시작 카드에 이름을 보여주려고).
    const created = idOf(data as Record<string, unknown>)
    const requested = str(objectArg(args.query_params).name)?.replace(/^\//, '')
    if (kind === 'containers' && pathId === 'create' && created && requested) remember(created, requested)
  }
}

// ---- 스택(Portainer compose 스택) ----
// 컨테이너를 직접 만드는 대신 스택으로 배포한다(Secure 정책표: 생성은 스택으로만).
// mcp-portainer 2.45.1은 Portainer OpenAPI로 도구를 만들고 경로·쿼리·본문 인자를 한 단계로 펼친다.
// 그래서 StackCreateDockerStandaloneString은 { endpointId, Name, StackFileContent, Env: [{name, value}] }로 온다.
// 스택 ID는 Portainer 전체에서 하나라서(환경과 무관) ID만으로 짝짓는다.

export interface StackInfo {
  name?: string
  // 마지막으로 본 compose의 서비스 이름. 수정 카드에서 빠지는 서비스를 알려줄 때 쓴다.
  services?: string[]
}

const MAX_STACKS = 500
const MAX_FILE = 3000

// 인자 이름은 대소문자가 섞여 온다(Name, endpointId). 모델이 바꿔 써도 찾게 대소문자를 무시한다.
function argOf(args: Record<string, unknown>, name: string): unknown {
  const key = Object.keys(args).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : args[key]
}

function numericId(value: unknown): string | undefined {
  return typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)) ? String(value) : undefined
}

interface ComposeDetails {
  services: string[]
  params: Record<string, string>
  reasons: RiskReason[]
  hostRisk: boolean
  // 읽지 못한 compose. 카드는 확인할 수 없는 작업처럼 띄운다.
  unreadable: boolean
  // 화면에 보여줄 compose. 환경변수 값은 가린다.
  shown: string
}

const HIDDEN = '••••'

// compose 환경변수는 목록(`- KEY=value`)이나 맵(`KEY: value`)으로 쓴다. 이름만 꺼낸다.
function envNames(env: unknown): string[] {
  if (Array.isArray(env)) return env.filter((e): e is string => typeof e === 'string').map((e) => e.split('=')[0])
  return env && typeof env === 'object' ? Object.keys(env) : []
}

function hideEnv(env: unknown): unknown {
  if (Array.isArray(env)) return env.map((e) => (typeof e === 'string' && e.includes('=') ? `${e.split('=')[0]}=${HIDDEN}` : e))
  if (env && typeof env === 'object') return Object.fromEntries(Object.keys(env).map((k) => [k, HIDDEN]))
  return env
}

// 서비스의 자원 상한. mem_limit·cpus와 deploy.resources.limits 두 곳에 적을 수 있다.
function serviceLimits(svc: Record<string, unknown>): string | undefined {
  const limits = objectArg(objectArg(objectArg(svc.deploy).resources).limits)
  const memory = svc.mem_limit ?? limits.memory
  const cpus = svc.cpus ?? limits.cpus
  const parts = [memory !== undefined ? `메모리 ${String(memory)}` : '', cpus !== undefined ? `CPU ${String(cpus)}` : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function parseCompose(content: string): unknown {
  try {
    return parseYaml(content, { maxAliasCount: 100 })
  } catch {
    return undefined
  }
}

// compose 파일에서 승인 전에 봐야 할 값을 고른다. 컨테이너 생성 카드(containerCreate)와 같은 기준이다.
function composeDetails(content: string): ComposeDetails {
  const doc = parseCompose(content)
  const services = objectArg(objectArg(doc).services)
  const names = Object.keys(services)
  if (!names.length) {
    return {
      services: [],
      params: {},
      reasons: [{ code: 'UNKNOWN', message: 'compose 파일을 읽지 못했어요. 내용을 직접 확인하고, 확실하지 않으면 거부해주세요.' }],
      hostRisk: false,
      unreadable: true,
      shown: maskText(cut(content, MAX_FILE)),
    }
  }

  const params: Record<string, string> = {}
  const reasons: RiskReason[] = []
  const images: string[] = []
  const ports: string[] = []
  const mounts: string[] = []
  const hostSources: string[] = []
  const elevated: string[] = []
  const shared: string[] = []
  const commands: string[] = []
  const env: string[] = []
  const limits: string[] = []
  const restarts: string[] = []

  for (const name of names) {
    const svc = objectArg(services[name])
    const limit = serviceLimits(svc)
    if (limit) limits.push(`${limit} (${name})`)
    const restart = str(svc.restart)
    if (restart) restarts.push(`${restart} (${name})`)
    images.push(`${name} (${str(svc.image) ?? (svc.build ? '직접 빌드' : '이미지 없음')})`)
    for (const p of Array.isArray(svc.ports) ? svc.ports : []) {
      if (typeof p === 'string' || typeof p === 'number') {
        ports.push(`${p} (${name})`)
        continue
      }
      const { published, target, host_ip: ip } = objectArg(p)
      ports.push(`${ip ? `${String(ip)}:` : ''}${String(published ?? '?')} → ${String(target ?? '?')} (${name})`)
    }
    for (const v of Array.isArray(svc.volumes) ? svc.volumes : []) {
      const long = objectArg(v)
      const source = typeof v === 'string' ? bindSource(v) : str(long.source)
      const type = typeof v === 'string' ? undefined : str(long.type)
      mounts.push(`${typeof v === 'string' ? v : `${source ?? '(익명)'} → ${str(long.target) ?? '?'}`} (${name})`)
      // `./data`, `/srv`, `~/x`, `C:\data`처럼 경로로 시작하면 호스트 경로다. 이름만 있으면 Docker 볼륨이다.
      if (source && (type === 'bind' || /^(\.{0,2}\/|~|[A-Za-z]:[\\/])/.test(source))) hostSources.push(source)
    }
    if (svc.privileged === true) elevated.push(`privileged (${name})`)
    const caps = strings(svc.cap_add)
    if (caps.length) elevated.push(`추가 권한 ${caps.join(', ')} (${name})`)
    if (Array.isArray(svc.devices) && svc.devices.length) elevated.push(`호스트 장치 (${name})`)
    for (const k of ['network_mode', 'pid', 'ipc', 'userns_mode'] as const) if (svc[k] === 'host') shared.push(`${k}=host (${name})`)
    const command = [...strings(svc.entrypoint), ...strings(svc.command)].join(' ')
    if (command) commands.push(`${name}: ${cut(command, 300)}`)
    env.push(...envNames(svc.environment))
  }

  params.서비스 = images.join(', ')
  if (ports.length) params.포트 = ports.join(', ')
  if (mounts.length) params.마운트 = mounts.join(', ')
  if (limits.length) params['자원 상한'] = limits.join(', ')
  if (restarts.length) params['재시작 정책'] = restarts.join(', ')
  if (commands.length) {
    params.명령 = maskText(commands.join('\n'))
    reasons.push({
      code: 'COMMAND',
      message: '컨테이너가 시작될 때 이 명령이 실행돼요. 보통은 이미지에 정해진 기본 명령이에요. 모르는 명령이 보이면 거부해주세요.',
    })
  }
  if (hostSources.some((src) => src.includes('docker.sock') || src === '/' || /^[A-Za-z]:[\\/]?$/.test(src))) {
    reasons.push({ code: 'HOST_TAKEOVER', message: '호스트 루트나 Docker 소켓을 연결하면 호스트 전체를 제어할 수 있어요.' })
  } else if (hostSources.length) {
    reasons.push({ code: 'HOST_MOUNT', message: `호스트 경로를 컨테이너에 연결해요: ${[...new Set(hostSources)].join(', ')}` })
  }
  if (elevated.length) {
    params.권한 = elevated.join(', ')
    reasons.push({ code: 'PRIVILEGED', message: '컨테이너가 호스트에 가까운 권한을 가져요.' })
  }
  if (shared.length) {
    params.공유 = shared.join(', ')
    reasons.push({ code: 'HOST_NAMESPACE', message: '컨테이너가 호스트의 네트워크·프로세스를 같이 써요.' })
  }
  if (env.length) params.환경변수 = `${[...new Set(env)].join(', ')} (값은 숨김)`

  // 화면용 compose: 환경변수 값을 가리고 다시 쓴다.
  const copy = structuredClone(doc) as { services: Record<string, unknown> }
  for (const svc of Object.values(copy.services)) {
    if (svc && typeof svc === 'object' && 'environment' in svc) {
      const s = svc as Record<string, unknown>
      s.environment = hideEnv(s.environment)
    }
  }
  const hostRisk = reasons.some((r) => ['HOST_TAKEOVER', 'PRIVILEGED', 'HOST_NAMESPACE'].includes(r.code))
  return { services: names, params, reasons, hostRisk, unreadable: false, shown: maskText(cut(stringifyYaml(copy), MAX_FILE)) }
}

// 스택 단위 환경변수(Env: [{name, value}]). compose의 ${VAR} 자리에 들어간다. 값은 비밀일 수 있어 이름만 보여준다.
function stackEnvNames(args: Record<string, unknown>): string[] {
  const env = argOf(args, 'Env')
  return Array.isArray(env) ? env.map((e) => str(objectArg(e).name)).filter((n): n is string => Boolean(n)) : []
}

function composeRisk(compose: ComposeDetails | undefined, safe: RiskLevel): RiskLevel {
  if (!compose || compose.unreadable) return UNKNOWN_RISK
  return compose.hostRisk ? { level: 'high', label: '호스트까지 영향' } : safe
}

const STACK_READS: Record<string, string> = {
  StackList: '스택 목록 조회',
  StackInspect: '스택 조회',
  StackFileInspect: '스택 파일 조회',
}

function stackAction(tool: string, args: Record<string, unknown>, stacks: ReadonlyMap<string, StackInfo>): ToolAction | undefined {
  const id = numericId(argOf(args, 'id'))
  const known = id ? stacks.get(id)?.name : undefined
  const name = known ?? (id ? `ID ${id}` : undefined)
  if (tool === 'StackFileInspect') return { label: STACK_READS[tool], summary: titled('스택', name, '파일 조회'), risk: { level: 'low', label: '조회' } }
  if (STACK_READS[tool]) return { label: STACK_READS[tool], summary: STACK_READS[tool], risk: { level: 'low', label: '조회' } }

  const target = id ? (known ? `${known} (스택 ID ${id})` : `스택 ID ${id}`) : undefined
  const envList = stackEnvNames(args)
  const withEnv = (params: Record<string, string>) =>
    envList.length ? { ...params, '스택 환경변수': `${envList.join(', ')} (값은 숨김)` } : params

  if (tool === 'StackCreateDockerStandaloneString') {
    const stackName = str(argOf(args, 'Name'))
    const content = str(argOf(args, 'StackFileContent'))
    const compose = content ? composeDetails(content) : undefined
    return {
      label: '스택 배포',
      summary: titled('스택', stackName, '배포'),
      target: stackName,
      params: withEnv({ ...compose?.params, ...(compose ? { 'compose 파일': compose.shown } : {}) }),
      reasons: [
        effect('compose 파일대로 컨테이너를 만들고 바로 실행해요. 없는 이미지는 받아 와요.'),
        ...(compose?.reasons ?? [{ code: 'UNKNOWN', message: 'compose 파일이 비어 있어요. 확실하지 않으면 거부해주세요.' }]),
      ],
      risk: composeRisk(compose, { level: 'low', label: '새로 만듦' }),
    }
  }

  if (tool === 'StackUpdate') {
    const content = str(argOf(args, 'StackFileContent'))
    const compose = content ? composeDetails(content) : undefined
    const reasons: RiskReason[] = []
    const params: Record<string, string> = { ...compose?.params }
    if (compose) {
      reasons.push(effect('새 compose 파일로 스택을 다시 배포해요. 설정이 바뀐 서비스는 컨테이너를 새로 만들어서 잠깐 끊겨요.'))
      const before = id ? stacks.get(id)?.services : undefined
      if (before && !compose.unreadable) {
        const removed = before.filter((x) => !compose.services.includes(x))
        const added = compose.services.filter((x) => !before.includes(x))
        if (added.length) params['새 서비스'] = added.join(', ')
        // Standalone 스택은 compose에서 뺀 서비스를 지우지 않는다(2026-11-05 Portainer 2.45 실측, Prune은 Swarm 전용).
        if (removed.length) {
          params['빠지는 서비스'] = removed.join(', ')
          reasons.push({
            code: 'ORPHANS',
            message: `compose에서 빠진 서비스(${removed.join(', ')})의 컨테이너는 지워지지 않고 계속 실행돼요. 멈추거나 지우려면 따로 요청해야 해요.`,
          })
        }
      } else if (!compose.unreadable) {
        reasons.push({ code: 'ORPHANS_HINT', message: 'compose에서 뺀 서비스가 있으면 그 컨테이너는 지워지지 않고 계속 실행돼요.' })
      }
      reasons.push(...compose.reasons)
      params['compose 파일'] = compose.shown
    } else {
      reasons.push(effect('compose 파일은 그대로 두고 스택을 다시 배포해요.'))
    }
    if (truthy(argOf(args, 'RepullImageAndRedeploy')) || truthy(argOf(args, 'PullImage'))) {
      reasons.push(effect('이미지를 다시 받아서 모든 서비스의 컨테이너를 새로 만들어요.'))
    }
    if (argOf(args, 'RollbackTo') !== undefined) reasons.push(effect('바로 전 compose 파일로 되돌려요.'))
    return {
      label: '스택 수정',
      summary: titled('스택', name, '수정'),
      target,
      params: withEnv(params),
      reasons,
      risk: compose ? composeRisk(compose, { level: 'medium', label: '다시 배포' }) : { level: 'medium', label: '다시 배포' },
    }
  }

  if (tool === 'StackStart') {
    return {
      label: '스택 시작',
      summary: titled('스택', name, '시작'),
      target,
      reasons: [effect('멈춰 있던 스택의 컨테이너를 모두 실행해요.')],
      risk: { level: 'low', label: '실행' },
    }
  }
  if (tool === 'StackStop') {
    return {
      label: '스택 중지',
      summary: titled('스택', name, '중지'),
      target,
      reasons: [effect('스택의 컨테이너가 모두 멈춰요. 지워지지는 않고 나중에 다시 시작할 수 있어요.')],
      risk: { level: 'medium', label: '서비스 멈춤' },
    }
  }
  if (tool === 'StackDelete') {
    const services = id ? stacks.get(id)?.services : undefined
    const volumes = truthy(argOf(args, 'removeVolumes'))
    return {
      label: '스택 삭제',
      summary: titled('스택', name, '삭제'),
      target,
      ...(services?.length ? { params: { 서비스: services.join(', ') } } : {}),
      reasons: [
        effect(volumes ? '스택과 소속 컨테이너가 지워져요.' : '스택과 소속 컨테이너가 지워져요. 볼륨은 남아요.'),
        ...(volumes ? [{ code: 'VOLUMES', message: 'compose에 적힌 볼륨과 그 안의 데이터도 같이 지워져요.' }] : []),
        DESTRUCTIVE,
      ],
      risk: IRREVERSIBLE,
    }
  }
  // 그 밖의 스택 도구(마이그레이션, Git 배포 등)는 문구 표가 없다. "확인할 수 없는 작업" 카드로 띄운다.
  return undefined
}

// 같은 스택을 바꾸는 요청끼리 비교하는 키. 만들기는 이름으로, 나머지는 ID(아는 이름도 같이)로 본다.
function stackKeys(tool: string, args: Record<string, unknown>, stacks: ReadonlyMap<string, StackInfo>): string[] {
  if (STACK_READS[tool]) return []
  if (tool === 'StackCreateDockerStandaloneString') {
    const name = str(argOf(args, 'Name'))
    return name ? [`stacks/name:${name.toLowerCase()}`] : []
  }
  const id = numericId(argOf(args, 'id'))
  if (!id) return []
  const name = stacks.get(id)?.name
  return [`stacks/${id}`, ...(name ? [`stacks/name:${name.toLowerCase()}`] : [])]
}

function rememberStack(stacks: Map<string, StackInfo>, id: string, info: StackInfo): void {
  if (!stacks.has(id) && stacks.size >= MAX_STACKS) stacks.delete(stacks.keys().next().value!)
  stacks.set(id, { ...stacks.get(id), ...info })
}

function servicesOf(content: string | undefined): string[] | undefined {
  if (!content) return undefined
  const services = Object.keys(objectArg(objectArg(parseCompose(content)).services))
  return services.length ? services : undefined
}

// 스택 조회·변경 결과에서 ID ↔ 이름과 서비스 목록을 알아 둔다. 모델이 select로 필드 이름을 바꾸므로 대소문자를 무시한다.
function learnStacks(stacks: Map<string, StackInfo>, tool: string, args: Record<string, unknown>, output: string): void {
  const id = numericId(argOf(args, 'id'))
  if (tool === 'StackDelete') {
    if (id) stacks.delete(id)
    return
  }
  let data: unknown
  try {
    data = output ? JSON.parse(output) : undefined
  } catch {
    data = undefined
  }
  if (tool === 'StackFileInspect') {
    const services = servicesOf(str(argOf(objectArg(data), 'StackFileContent')))
    if (id && services) rememberStack(stacks, id, { services })
    return
  }
  for (const item of (Array.isArray(data) ? data : [data]).slice(0, 1000)) {
    const obj = objectArg(item)
    const itemId = numericId(argOf(obj, 'id'))
    const name = str(argOf(obj, 'name'))
    if (itemId && name) rememberStack(stacks, itemId, { name })
  }
  // 만들기·고치기가 성공하면 그때 쓴 compose가 지금 compose다.
  const services = servicesOf(str(argOf(args, 'StackFileContent')))
  const created = numericId(argOf(objectArg(data), 'id'))
  if (tool === 'StackCreateDockerStandaloneString' && created) {
    const name = str(argOf(args, 'Name'))
    rememberStack(stacks, created, { ...(name ? { name } : {}), ...(services ? { services } : {}) })
  }
  if (tool === 'StackUpdate' && id && services) rememberStack(stacks, id, { services })
}
