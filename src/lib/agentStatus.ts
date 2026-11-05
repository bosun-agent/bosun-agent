import { useEffect, useState } from 'react'
import type { AgentProcessStatus } from './agentProtocol'
import { agent } from './agent'

// WEB 백엔드가 띄운 Docker Agent 상태(계약 3장 GET /api/agent). 몇 초마다 다시 읽는다. 목업에는 없다.
const POLL_MS = 3_000

export function useAgentStatus(): [AgentProcessStatus | null, (s: AgentProcessStatus) => void] {
  const [status, setStatus] = useState<AgentProcessStatus | null>(null)
  useEffect(() => {
    if (!agent.getAgentStatus) return
    let alive = true
    const load = () =>
      agent.getAgentStatus!().then(
        (s) => alive && setStatus(s),
        () => undefined,
      )
    void load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  return [status, setStatus]
}

// 설정의 정보 화면에도 같은 문장을 쓴다.
export function agentStateText(s: AgentProcessStatus): string {
  switch (s.state) {
    case 'off':
      return s.reachable ? '켜져 있음(WEB이 띄우지 않음)' : '꺼져 있음(WEB이 띄우지 않음)'
    case 'external':
      return s.reachable ? '켜져 있음(따로 띄운 Agent)' : '꺼짐(따로 띄운 Agent)'
    case 'starting':
      return '켜는 중'
    case 'restarting':
      return '다시 켜는 중'
    case 'running':
      return s.reachable === false ? '응답 없음' : '켜져 있음'
    case 'crashed':
      return '멈춤'
  }
}

export async function restartAgent(onStatus: (s: AgentProcessStatus) => void): Promise<void> {
  if (!agent.restartAgent) return
  const res = await agent.restartAgent().catch(() => null)
  if (res) onStatus(res.status)
}
