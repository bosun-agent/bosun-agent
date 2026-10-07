// Docker Agent 이벤트 → WEB 이벤트(계약 8.1 대응표). 표에 없는 이벤트는 버린다.
// 승인 요청(approval_required)은 여기서 만들지 않는다. Airlock webhook에서 온다(계약 6장).

import type { AgentEvent } from '../src/lib/agentProtocol.ts'
import type { DAEvent } from './agentClient.ts'
import { maskText } from './mask.ts'
import { toolSummary } from './tools.ts'

// Airlock 0.2.38 하드 차단 문구(계약 6장).
// arg_policy 위반은 isError 결과 본문으로 그대로 온다(`middleware/core/arg-policy.js` violationResponse).
const ARG_POLICY_DENIED = /^[\w.[\]]+ .+ is not permitted for [\w.-]+\. Allowed /
// 노출 안 된 도구는 MCP 오류(McpError)로 온다. Docker Agent가 "Error calling tool: failed to call tool: "로 감싸고
// MCP SDK가 "MCP error <code>: "를 붙인다. 가운데 감싸는 문구는 실제 연동 때 한 번 확인한다.
const TOOL_NOT_AVAILABLE = /^Error calling tool: .*MCP error -?\d+: Tool not available: /

export function isHardBlock(response: string, isError: boolean): boolean {
  if (!isError) return false
  return ARG_POLICY_DENIED.test(response) || TOOL_NOT_AVAILABLE.test(response)
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
        if (isHardBlock(res.response, isError)) {
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

      case 'tool_call_confirmation':
      case 'elicitation_request':
        // Airlock 모드에서는 오면 안 된다. 조용히 멈추지 않게 설정 오류로 끝낸다(계약 6장).
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
