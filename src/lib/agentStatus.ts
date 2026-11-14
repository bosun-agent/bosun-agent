import { useEffect, useState } from 'react'
import type { AgentProcessStatus } from './agentProtocol'
import { agent } from './agent'

// WEB 백엔드가 띄운 Docker Agent 상태(GET /api/agent). 몇 초마다 다시 읽는다. 목업에는 없다.
const POLL_MS = 3_000
// 이만큼 연달아 못 읽으면 WEB 백엔드 자체가 꺼진 것으로 본다(한 번은 잠깐 끊김일 수 있다).
const DOWN_AFTER = 2

// 셋째 값: WEB 백엔드에 연결이 안 되는지. 이때는 Agent 상태도 알 수 없다.
export function useAgentStatus(): [AgentProcessStatus | null, (s: AgentProcessStatus) => void, boolean] {
  const [status, setStatus] = useState<AgentProcessStatus | null>(null)
  const [backendDown, setBackendDown] = useState(false)
  useEffect(() => {
    if (!agent.getAgentStatus) return
    let alive = true
    let failures = 0
    const load = () =>
      agent.getAgentStatus!().then(
        (s) => {
          failures = 0
          if (!alive) return
          setStatus(s)
          setBackendDown(false)
        },
        () => {
          failures++
          if (alive && failures >= DOWN_AFTER) setBackendDown(true)
        },
      )
    void load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  return [status, setStatus, backendDown]
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
