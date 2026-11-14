// 화면이 쓸 Agent 클라이언트를 고른다. `npm run dev:http`(VITE_AGENT=http)면 WEB 백엔드, 아니면 목업.

import type { AgentClient } from './agentProtocol'
import { httpAgent } from './httpAgent'
import { mockAgent } from './mockAgent'

export const usingMock = import.meta.env.VITE_AGENT !== 'http'

// 시나리오 버튼은 개발 모드와 공개 데모 빌드(`npm run build:demo`, VITE_DEMO=1)에서만 보인다.
export const isDemo = import.meta.env.VITE_DEMO === '1'
export const showScenarios = usingMock && (import.meta.env.DEV || isDemo)

export const agent: AgentClient = usingMock ? mockAgent : httpAgent
