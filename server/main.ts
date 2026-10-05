// WEB 백엔드(BFF) 진입점. 실행: npm run server (개발용 값은 server/dev/dev.env)

import { serve } from '@hono/node-server'
import { app } from './app.ts'
import { config } from './config.ts'
import { cleanupPending, pollPending } from './turns.ts'

if (!config.airlockSecret) console.warn('[config] AIRLOCK_MGMT_SECRET is empty: approve/deny will fail')
if (!config.webhookToken) console.warn('[config] WEBHOOK_TOKEN is empty: webhook accepts any caller')
if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
  // 로그인을 붙이기 전에는 승인 엔드포인트를 바깥에 열면 안 된다(계약 3장).
  console.warn(`[config] listening on ${config.host} without login`)
}

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.info(`[web] listening on http://${info.address}:${info.port}`)
  console.info(`[web] agent ${config.agentUrl} (agent "${config.agentName}"), airlock ${config.airlockUrl}`)
})

cleanupPending().catch((err) => console.warn('[airlock] startup cleanup skipped:', err.message))

setInterval(() => {
  pollPending().catch((err) => console.warn('[airlock] pending poll failed:', err.message))
}, config.pendingPollMs)
