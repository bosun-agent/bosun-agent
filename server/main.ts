// WEB 백엔드(BFF) 진입점. 실행: npm start(진짜 Agent, server/real.env) 또는 npm run server(가짜 Agent, server/dev/dev.env)

import { serve } from '@hono/node-server'
import { startAgent, stopAgent } from './agentProcess.ts'
import { app } from './app.ts'
import { config } from './config.ts'
import { isLoopbackHost } from './guard.ts'
import { cancelPendingCards } from './store.ts'
import { runningCount } from './turns.ts'

// 로그인이 없으므로 같은 네트워크의 다른 PC가 붙을 수 있는 주소로는 뜨지 않는다.
if (!isLoopbackHost(config.host) && !config.inContainer) {
  console.error(`[config] HOST=${config.host} is not loopback. BOSUN WEB has no login; listen on 127.0.0.1 only`)
  process.exit(1)
}

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.info(`[web] listening on http://${info.address}:${info.port}`)
  console.info(`[web] agent ${config.agentUrl} (agent "${config.agentName}")`)
})

// 백엔드가 꺼지면 Agent 스트림도 끊기고, Docker Agent는 기다리던 승인을 취소한다.
const cancelled = cancelPendingCards()
if (cancelled > 0) console.info(`[store] marked ${cancelled} pending card(s) as cancelled`)

// AGENT_BIN이 있으면 Docker Agent도 같이 띄운다. 백엔드가 꺼지면 Agent도 끈다(server/agentProcess.ts).
void startAgent(() => runningCount() === 0)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void stopAgent().finally(() => process.exit(0)))
}
