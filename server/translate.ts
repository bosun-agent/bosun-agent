// Docker Agent 이벤트 → WEB 이벤트(계약 8.1 대응표). 표에 없는 이벤트는 버린다.
// 승인 요청(tool_call_confirmation)은 여기서 바꾸지 않는다. turns.ts가 카드를 만들고 결정을 기다린다(계약 6장).

import type { AgentEvent } from '../src/lib/agentProtocol.ts'
import type { DAEvent } from './agentClient.ts'
import { maskText } from './mask.ts'
import { describeTool, toolSummary } from './tools.ts'

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

// 모델이 도구 호출을 정해진 형식 대신 자기 내부 표기로 글에 써 버린 경우(DeepSeek, 2026-10-28 실측:
// "<｜DSML｜ invoke name=\"EndpointList\">"). Agent는 도구를 부르지 않고 그 글을 답으로 끝낸다.
// 화면에는 표기를 보이지 않고, 턴이 끝나면 다시 시도하라고 알린다.
const LEAKED_TOOL_CALL = /<｜\s*(DSML|tool)/
// 표기가 조각으로 나뉘어 올 수 있어서, 끝에 걸친 "<｜…" 앞부분은 이만큼까지 다음 조각을 기다린다.
const HOLD_MAX = 12

export interface Translated {
  events: AgentEvent[]
  // 설정 오류처럼 더 진행하면 안 되는 경우 Agent 스트림을 끊는다.
  abort?: boolean
}

export class Translator {
  private initStarted = false
  private initFinished = false
  private failed = false
  // 도구 호출 ID → 작업 이름. 결과 이벤트에는 인자가 없어서 호출 때 정해 둔다.
  // 거부·차단된 호출은 tool_call 없이 결과만 오므로 공통 문구가 된다.
  private labels = new Map<string, string | undefined>()
  // 도구 호출 앞뒤 문장이 붙어 나오지 않게, 도구 호출 뒤 첫 문장 앞에 빈 줄을 넣는다.
  private text = ''
  private toolSinceText = false
  // 이 턴에서 모델이 글이나 도구 호출을 하나라도 냈는지. 아무것도 없이 끝나면 빈 답으로 알린다(2026-10-28 실측).
  private produced = false
  // 도구 호출 표기인지 아직 모르는 글 끝부분, 그리고 표기가 나왔는지(그 뒤 글은 보내지 않는다)
  private held = ''
  private leaked = false

  // 모델 글 조각 → 화면에 보낼 text_delta. 마스킹하고, 도구 호출 바로 뒤 첫 문장 앞에는 빈 줄을 넣는다.
  private textEvents(raw: string): AgentEvent[] {
    if (!raw) return []
    let delta = maskText(raw)
    if (this.toolSinceText && this.text) {
      const trailing = /\n*$/.exec(this.text)![0].length
      delta = '\n'.repeat(Math.max(0, 2 - trailing)) + delta
    }
    this.toolSinceText = false
    this.text = (this.text + delta).slice(-8)
    return [{ type: 'text_delta', delta }]
  }

  // 붙잡아 둔 글 끝부분을 내보낸다(도구 호출이나 턴 끝처럼 더 이어지지 않을 때).
  private flushHeld(): AgentEvent[] {
    const held = this.held
    this.held = ''
    return this.leaked ? [] : this.textEvents(held)
  }

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
        if (!content) return { events: [] }
        this.produced = true
        if (this.leaked) return { events: [] }
        let text = this.held + content
        this.held = ''
        const leak = LEAKED_TOOL_CALL.exec(text)
        if (leak) {
          this.leaked = true
          text = text.slice(0, leak.index)
        } else {
          const cut = text.lastIndexOf('<')
          if (cut >= 0 && text.length - cut < HOLD_MAX && !/[>\n]/.test(text.slice(cut))) {
            this.held = text.slice(cut)
            text = text.slice(0, cut)
          }
        }
        return { events: this.textEvents(text) }
      }

      case 'tool_call': {
        const call = (ev as Extract<DAEvent, { type: 'tool_call' }>).tool_call
        const name = call.function.name ?? ''
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.function.arguments || '{}')
        } catch {
          // 인자를 못 읽으면 공통 문구를 쓴다.
        }
        const label = describeTool(name, args)?.label
        if (call.id) this.labels.set(call.id, label)
        const before = this.flushHeld()
        // 표기를 글로 썼어도 실제 도구 호출이 이어지면 정상 진행이다. 그 뒤 글은 다시 보낸다.
        this.leaked = false
        this.toolSinceText = true
        this.produced = true
        const callId = call.id ? { callId: call.id } : {}
        return {
          events: [...before, { type: 'tool_status', tool: name, status: 'running', summary: toolSummary(label, 'running'), ...callId }],
        }
      }

      case 'tool_call_response': {
        const res = ev as Extract<DAEvent, { type: 'tool_call_response' }>
        const name = res.tool_definition?.name ?? ''
        const isError = res.result?.isError ?? false
        const label = this.labels.get(res.tool_call_id)
        this.labels.delete(res.tool_call_id)
        this.toolSinceText = true
        this.produced = true
        if (isError && USER_REJECTED.test(res.response)) return { events: [] }
        if (isPolicyDenied(res.response, isError)) {
          // 규칙 ID가 오지 않으므로 공통 코드를 쓴다. 이어지는 Agent 설명이 text_delta로 온다(계약 6장).
          // 막힌 호출은 실행되지 않아 tool_call이 없다. 처리 과정에는 "정책에 따라 차단됨" 한 줄만 남기도록 tool_status는 보내지 않는다.
          return { events: [{ type: 'rejected', code: 'POLICY_DENIED', reason: POLICY_DENIED_REASON }] }
        }
        const status = isError ? 'failed' : 'succeeded'
        return {
          events: [{ type: 'tool_status', tool: name, status, summary: toolSummary(label, status), callId: res.tool_call_id }],
        }
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
          this.produced = true
          return { events: [{ type: 'rejected', code: 'HOOK_BLOCKED', reason: HOOK_BLOCKED_REASON }] }
        }
        this.failed = true
        // 모델이 같은 도구 호출을 계속 되풀이하면 Docker Agent가 턴을 끊는다(2026-10-28 실측, 5번 연속).
        // 그대로 다시 보내면 또 되풀이할 가능성이 크므로 요청을 바꿔 보라고 안내한다.
        if (err.code === 'loop_detected') {
          return {
            events: [
              { type: 'error', code: 'LOOP_DETECTED', message: 'AI가 같은 요청을 계속 되풀이해서 멈췄어요. 요청을 조금 바꿔서 다시 보내주세요.' },
            ],
          }
        }
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
        if (this.failed) return { events: [] }
        // 모델이 글도 도구 호출도 없이 끝내면 done만 와서 화면에 아무것도 안 남는다. 다시 시도할 수 있게 오류로 알린다.
        if (!this.produced) {
          return { events: [{ type: 'error', code: 'EMPTY_REPLY', message: 'AI가 빈 답을 보냈어요. 다시 시도해주세요.' }] }
        }
        if (this.leaked) {
          return {
            events: [{ type: 'error', code: 'TOOL_CALL_AS_TEXT', message: 'AI가 도구를 제대로 부르지 못했어요. 다시 시도해주세요.' }],
          }
        }
        return { events: [...this.flushHeld(), { type: 'done' }] }

      default:
        return { events: [] }
    }
  }
}
