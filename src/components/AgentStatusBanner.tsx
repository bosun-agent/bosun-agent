import { useState } from 'react'
import { restartAgent, useAgentStatus } from '../lib/agentStatus'

// 채팅 화면 위쪽 안내. Agent가 정상이면 아무것도 그리지 않는다.
export function AgentStatusBanner() {
  const [status, setStatus, backendDown] = useAgentStatus()
  const [busy, setBusy] = useState(false)
  if (!status && !backendDown) return null

  let tone: 'info' | 'error' | null = null
  let text = ''
  let canRestart = false
  if (backendDown || !status) {
    tone = 'error'
    text = 'WEB 백엔드에 연결할 수 없어요. npm start를 켠 터미널이 아직 켜져 있는지 확인해주세요.'
  } else if (status.state === 'starting') {
    tone = 'info'
    text = 'AI Agent를 켜는 중이에요…'
  } else if (status.state === 'restarting') {
    tone = 'info'
    text = status.error ? `AI Agent가 멈춰서 다시 켜는 중이에요. ${status.error}` : 'AI Agent를 다시 켜는 중이에요…'
  } else if (status.state === 'crashed') {
    tone = 'error'
    text = `AI Agent가 멈췄어요. ${status.error ?? ''}`
    canRestart = true
  } else if (status.pendingRestart) {
    tone = 'info'
    text = '처리 중인 대화가 끝나면 AI Agent를 다시 시작해서 새 API 키를 적용해요.'
  } else if (status.reachable === false) {
    tone = 'error'
    text = status.managed && status.state === 'running'
      ? 'AI Agent가 응답하지 않아요.'
      : 'AI Agent에 연결할 수 없어요. Agent를 켠 뒤 다시 시도해주세요.'
    canRestart = status.managed && status.state === 'running'
  }
  if (!tone) return null

  async function restart() {
    setBusy(true)
    await restartAgent(setStatus)
    setBusy(false)
  }

  return (
    <div className="flex justify-center px-14 pt-3">
      <div
        role="status"
        className={`flex max-w-2xl items-center gap-3 rounded-lg px-3 py-1.5 text-sm ${
          tone === 'error' ? 'bg-red-50 text-red-700' : 'bg-neutral-100 text-neutral-700'
        }`}
      >
        <span>{text}</span>
        {canRestart && (
          <button
            type="button"
            onClick={restart}
            disabled={busy}
            className="shrink-0 rounded-lg border border-current px-2 py-0.5 text-xs disabled:opacity-40"
          >
            다시 시작
          </button>
        )}
      </div>
    </div>
  )
}
