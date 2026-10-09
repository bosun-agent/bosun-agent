// Docker Agent 이벤트 → WEB 이벤트(계약 8.1 대응표). 표에 없는 이벤트는 버린다.
// 승인 요청(tool_call_confirmation)은 여기서 바꾸지 않는다. turns.ts가 카드를 만들고 결정을 기다린다(계약 6장).

import type { AgentEvent } from '../src/lib/agentProtocol.ts'
import type { DAEvent } from './agentClient.ts'
import { maskText } from './mask.ts'
import { toolSummary } from './tools.ts'

// 도구 호출이 정책으로 막혔을 때 Docker Agent가 도구 결과로 돌려주는 문구(v1.145.0 `pkg/runtime/toolexec`).
// 도구 결과에는 컨테이너 이름·로그 같은 외부 문자열이 섞이므로 맨 앞부터 맞춰 본다(계약 6장).
// - permissions.deny 또는 restricted 모드: "Tool 'x' is denied by permissions configuration." 등(denyErrorMessage)
// - tool_guard·tool_input_transform·pre_tool_use·permission_request 훅 거부: blockToolHook
const POLICY_DENIED = [/^Tool '[^']+' is denied by /, /^The tool call was rejected by a \w+ hook\./]
// 사용자가 거부했거나 WEB이 만료로 거부한 경우(handleResume). 카드에 이미 결과가 나오므로 따로 알리지 않는다.
const USER_REJECTED = /^The user rejected the tool call\./

export function isPolicyDenied(response: string, isError: boolean): boolean {
  return isError && POLICY_DENIED.some((re) => re.test(response))
}

const HOOK_BLOCKED_REASON = '보안 규칙에 걸려 요청을 처리하지 않았어요.'
const POLICY_DENIED_REASON = '보안 정책에 따라 이 작업은 실행하지 않았어요.'

export interface Translated {
  events: AgentEvent[]
  // 설정 오류처럼 더 진행하면 안 되는 경우 Agent 스트림을 끊는다.
  abort?: boolean
}

export class Translator {
  private initStarted = false
  private initFinished = false
  private failed = false

  translate(ev: DAEvent): Translated {
    switch (ev.type) {
      case 'mcp_init_started':
        // 한 턴 안에서 모델을 다시 부를 때마다 반복되므로 첫 번째만 쓴다(계약 8.1).
        if (this.initStarted) return { events: [] }
        this.initStarted = true
        return { events: [{ type: 'progress', step: 'loading_tools' }] }

      case 'mcp_init_finished':
        if (this.initFinished) return { events: [] }
        this.initFinished = true
        return { events: [{ type: 'progress', step: 'understanding' }] }

      case 'agent_choice': {
        const { content } = ev as Extract<DAEvent, { type: 'agent_choice' }>
        return content ? { events: [{ type: 'text_delta', delta: maskText(content) }] } : { events: [] }
      }

      case 'tool_call': {
        const name = (ev as Extract<DAEvent, { type: 'tool_call' }>).tool_call.function.name ?? ''
        return { events: [{ type: 'tool_status', tool: name, status: 'running', summary: toolSummary(name, 'running') }] }
      }

      case 'tool_call_response': {
        const res = ev as Extract<DAEvent, { type: 'tool_call_response' }>
        const name = res.tool_definition?.name ?? ''
        const isError = res.result?.isError ?? false
        if (isError && USER_REJECTED.test(res.response)) return { events: [] }
        if (isPolicyDenied(res.response, isError)) {
          // 규칙 ID가 오지 않으므로 공통 코드를 쓴다. 이어지는 Agent 설명이 text_delta로 온다(계약 6장).
          return {
            events: [
              { type: 'tool_status', tool: name, status: 'failed', summary: toolSummary(name, 'failed') },
              { type: 'rejected', code: 'POLICY_DENIED', reason: POLICY_DENIED_REASON },
            ],
          }
        }
        const status = isError ? 'failed' : 'succeeded'
        return { events: [{ type: 'tool_status', tool: name, status, summary: toolSummary(name, status) }] }
      }

      case 'elicitation_request':
        // MCP 서버가 사용자 입력을 요청한 경우. WEB에는 이 입력 화면이 없으므로 조용히 멈추지 않게 설정 오류로 끝낸다.
        this.failed = true
        return {
          events: [
            {
              type: 'error',
              code: 'AGENT_CONFIG',
              message: 'AI Agent 설정 오류로 작업을 멈췄어요. 관리자에게 알려주세요.',
            },
          ],
          abort: true,
        }

      case 'error': {
        const err = ev as Extract<DAEvent, { type: 'error' }>
        console.warn('[agent error]', err.code ?? '', err.error)
        if (err.code === 'hook_blocked') {
          // Agent 훅이 턴을 멈춘 경우. 훅 메시지 원문은 로그에만 남긴다(계약 6장).
          return { events: [{ type: 'rejected', code: 'HOOK_BLOCKED', reason: HOOK_BLOCKED_REASON }] }
        }
        this.failed = true
        // 키가 틀리거나 만료되면 모델 호출이 401로 실패한다. 다시 시도해도 같으므로 따로 안내한다.
        if (err.code === 'model_error' && /HTTP 401\b/.test(err.error)) {
          return {
            events: [
              { type: 'error', code: 'INVALID_API_KEY', message: 'AI 모델 API 키가 올바르지 않아요. 관리자에게 알려주세요.' },
            ],
          }
        }
        return {
          events: [
            {
              type: 'error',
              code: err.code ?? 'AGENT_ERROR',
              message: '처리 중 오류가 났어요. 잠시 후 다시 시도해주세요.',
            },
          ],
        }
      }

      case 'stream_stopped':
        // error로 끝난 스트림에는 done을 붙이지 않는다(계약 4장: 스트림은 done·error·approval_required 중 하나로 끝남).
        return { events: this.failed ? [] : [{ type: 'done' }] }

      default:
        return { events: [] }
    }
  }
}
