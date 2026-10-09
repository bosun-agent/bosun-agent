// WEB 백엔드(BFF) 진입점. 실행: npm run server (개발용 값은 server/dev/dev.env)

import { serve } from '@hono/node-server'
import { app } from './app.ts'
import { config } from './config.ts'
import { cancelPendingCards } from './store.ts'

if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
  // 로그인을 붙이기 전에는 승인 엔드포인트를 바깥에 열면 안 된다(계약 3장).
  console.warn(`[config] listening on ${config.host} without login`)
}

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.info(`[web] listening on http://${info.address}:${info.port}`)
  console.info(`[web] agent ${config.agentUrl} (agent "${config.agentName}")`)
})

// 백엔드가 꺼지면 Agent 스트림도 끊기고, Docker Agent는 기다리던 승인을 취소한다(계약 6장).
const cancelled = cancelPendingCards()
if (cancelled > 0) console.info(`[store] marked ${cancelled} pending card(s) as cancelled`)
