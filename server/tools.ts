// 도구 이름 → 화면 문구. 처리 과정 줄과 승인 카드를 코드 템플릿으로 만든다(LLM 재요약 금지, 계약 4장).
// proxy_* 이름은 Airlock alias 기준으로 만든 자리표시다. Portainer MCP를 직접 붙인 뒤 실제 도구 이름으로 바꾼다(계약 7장).
// 도구 인자는 승인 카드에 허용 목록으로 고른 값만 싣고, 처리 과정에는 싣지 않는다(계약 5장 4항).

import type { ProposedAction, RiskReason } from '../src/lib/agentProtocol.ts'
import { maskText } from './mask.ts'

interface ToolInfo {
  // 처리 과정 문구에 쓰는 작업 이름
  label: string
  // 승인 카드 문구에 쓰는 동사구
  verb?: string
  reasons?: RiskReason[]
}

const TOOLS: Record<string, ToolInfo> = {
  proxy_read: { label: '조회' },
  proxy_lifecycle: { label: '상태 변경', verb: '상태 변경' },
  proxy_delete: {
    label: '삭제',
    verb: '삭제',
    reasons: [{ code: 'DESTRUCTIVE', message: '삭제하면 되돌릴 수 없어요.' }],
  },
  proxy_exec: {
    label: '명령 실행',
    verb: '명령 실행',
    reasons: [{ code: 'EXEC', message: '컨테이너 안에서 명령이 그대로 실행돼요. 명령을 확인해주세요.' }],
  },
}

const RESOURCES: Record<string, string> = {
  containers: '컨테이너',
  images: '이미지',
  networks: '네트워크',
  volumes: '볼륨',
  exec: 'exec',
}

export function toolSummary(tool: string, status: 'running' | 'succeeded' | 'failed'): string {
  const label = TOOLS[tool]?.label
  if (!label) return { running: '도구 호출하는 중', succeeded: '실행 완료', failed: '실행 실패' }[status]
  return { running: `${label}하는 중`, succeeded: `${label} 완료`, failed: `${label} 실패` }[status]
}

// docker_proxy 인자의 path(`/containers/{id}/...`)에서 리소스 종류와 식별값을 읽는다.
function parsePath(path: unknown): { resource?: string; target?: string } {
  if (typeof path !== 'string') return {}
  const [kind, id] = path.split('/').filter(Boolean)
  const resource = RESOURCES[kind]
  if (!resource || !id) return {}
  return { resource, target: decodeURIComponent(id) }
}

// exec 생성 요청의 body.Cmd. body는 객체나 JSON 문자열로 올 수 있다.
export function execCommand(args: Record<string, unknown>): string | undefined {
  let body = args.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return undefined
    }
  }
  const cmd = (body as { Cmd?: unknown } | undefined)?.Cmd
  if (Array.isArray(cmd)) return cmd.map(String).join(' ')
  return typeof cmd === 'string' ? cmd : undefined
}

export interface ApprovalCard {
  summary: string
  action: ProposedAction
  reasons: RiskReason[]
}

// execCommands: exec 생성 결과로 받은 exec ID → 명령. `/exec/{id}/start` 카드에 명령을 보여주려고 쓴다(계약 7장).
export function approvalCard(
  tool: string,
  args: Record<string, unknown>,
  execCommands: ReadonlyMap<string, string>,
): ApprovalCard {
  const info = TOOLS[tool]
  const { resource, target } = parsePath(args.path)
  const params: Record<string, unknown> = {}

  if (typeof args.method === 'string' && typeof args.path === 'string') {
    params.요청 = `${args.method} ${args.path}`
  }
  const command =
    tool === 'proxy_exec'
      ? (execCommand(args) ?? (resource === 'exec' && target ? execCommands.get(target) : undefined))
      : undefined
  if (command) params.명령 = maskText(command)

  const action: ProposedAction = { tool, ...(target ? { target } : {}) }
  if (Object.keys(params).length > 0) action.params = params

  if (!info?.verb) {
    return { summary: '승인이 필요한 작업입니다.', action, reasons: [] }
  }
  const subject = resource && resource !== 'exec' && target ? `${resource} ${target} ` : ''
  return { summary: `${subject}${info.verb}`, action, reasons: info.reasons ?? [] }
}
