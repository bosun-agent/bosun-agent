// 도구 호출 → 화면 문구. 처리 과정 줄과 승인 카드를 코드 템플릿으로 만든다(LLM 재요약 금지, 계약 4장).
// 도구는 Portainer MCP(mcp-portainer)의 docker_proxy와 EndpointList다(Agent 담당 agent.direct.yaml, 계약 7장).
// docker_proxy는 Docker Engine API 요청 하나라서 method와 path로 작업을 고른다.
// 도구 인자는 승인 카드에 허용 목록으로 고른 값만 싣고, 처리 과정에는 싣지 않는다(계약 5장 4항).

import type { ProposedAction, RiskReason } from '../src/lib/agentProtocol.ts'

interface ToolAction {
  // 처리 과정 문구에 쓰는 작업 이름
  label: string
  // 승인 카드 제목. 없으면 공통 문구로 띄운다
  summary?: string
  target?: string
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

// query_params는 객체나 JSON 문자열로 올 수 있다.
function queryParams(value: unknown): Record<string, unknown> {
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

// 대상이 있으면 "컨테이너 web 중지", 없으면 "컨테이너 중지"
function titled(resource: string, target: string | undefined, verb: string): string {
  return target ? `${resource} ${target} ${verb}` : `${resource} ${verb}`
}

function dockerRequest(method: string, path: string, query: Record<string, unknown>): ToolAction {
  const [kind, ...rest] = pathParts(path)
  const resource = RESOURCES[kind]
  // GET은 permissions.allow라 보통 묻지 않는다. method를 빼고 부르면 승인 카드가 뜬다.
  if (method === 'GET' || method === 'HEAD') return { label: '조회', summary: resource ? `${resource} 조회` : '조회' }
  if (!resource) return { label: '변경' }

  if (method === 'DELETE') {
    // 이미지 이름에는 `/`가 들어간다(DELETE /images/library/nginx).
    const target = rest.join('/') || undefined
    return { label: '삭제', summary: titled(resource, target, '삭제'), target, reasons: [DESTRUCTIVE] }
  }

  if (rest.length === 1 && rest[0] === 'create') {
    if (kind === 'images') {
      const image = str(query.fromImage)
      const tag = str(query.tag)
      const target = image && tag ? `${image}:${tag}` : image
      return { label: '이미지 다운로드', summary: titled('이미지', target, '다운로드'), target }
    }
    const target = str(query.name)
    return { label: '생성', summary: titled(resource, target, '생성'), target }
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
  return dockerRequest(method, str(args.path) ?? '', queryParams(args.query_params))
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

export function approvalCard(tool: string, args: Record<string, unknown>): ApprovalCard {
  const info = describeTool(tool, args)
  const action: ProposedAction = { tool, ...(info?.target ? { target: info.target } : {}) }
  if (tool === 'docker_proxy' && typeof args.path === 'string') {
    action.params = { 요청: `${(str(args.method) ?? 'GET').toUpperCase()} ${args.path}` }
  }
  if (!info?.summary) return { summary: '승인이 필요한 작업입니다.', action, reasons: [] }
  return { summary: info.summary, action, reasons: info.reasons ?? [] }
}
