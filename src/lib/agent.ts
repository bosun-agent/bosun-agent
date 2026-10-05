// 화면이 쓸 Agent 클라이언트를 고른다. `npm run dev:http`(VITE_AGENT=http)면 WEB 백엔드, 아니면 목업.

import type { AgentClient } from './agentProtocol'
import { httpAgent } from './httpAgent'
import { mockAgent } from './mockAgent'

export const usingMock = import.meta.env.VITE_AGENT !== 'http'

export const agent: AgentClient = usingMock ? mockAgent : httpAgent
