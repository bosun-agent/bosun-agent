// WEB 백엔드 설정. 주소와 비밀값은 환경변수로 받는다.
// 연동 전에 받을 값(Airlock secret, webhook 헤더 등)은 인터페이스 계약 7장에 있다.

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number: ${raw}`)
  return value
}

export const config = {
  // 브라우저(Vite 개발 서버 프록시)가 붙는 주소. 로그인을 붙이기 전까지는 루프백에서만 연다(계약 3장).
  host: process.env.HOST ?? '127.0.0.1',
  port: num('PORT', 3001),

  // Docker Agent API 서버(`docker agent serve api`). 기본 주소는 Agent 담당 확인값(계약 7장).
  agentUrl: process.env.AGENT_URL ?? 'http://127.0.0.1:8080',
  // POST /api/sessions/:id/agent/:agent의 :agent. Docker Agent의 GET /api/agents로 확인한다.
  agentName: process.env.AGENT_NAME ?? 'agent',
  // `serve api --auth-token`을 켰을 때만 넣는다.
  agentToken: process.env.AGENT_TOKEN ?? '',

  // Airlock management API. secret은 브라우저에 절대 내려보내지 않는다(계약 6장).
  airlockUrl: process.env.AIRLOCK_MGMT_URL ?? 'http://127.0.0.1:4113',
  airlockSecret: process.env.AIRLOCK_MGMT_SECRET ?? '',
  // 비어 있으면 모든 agentId를 받는다. Airlock config의 agent id와 맞춘다.
  airlockAgentId: process.env.AIRLOCK_AGENT_ID ?? '',
  // Airlock webhook provider의 headers에 `Authorization: Bearer <값>`으로 넣을 값.
  webhookToken: process.env.WEBHOOK_TOKEN ?? '',

  // expiresAt은 webhook 받은 시각 + timeoutMs에서 이만큼 앞당긴다(계약 7.1).
  approvalMarginMs: num('APPROVAL_MARGIN_MS', 20_000),
  // 브라우저가 만료 거부를 먼저 보낼 수 있게, 서버 쪽 자동 거부는 expiresAt보다 조금 늦게 한다.
  expiryGraceMs: num('EXPIRY_GRACE_MS', 3_000),
  // webhook을 놓쳤을 때를 대비한 GET /hitl/pending 보조 조회 간격(계약 6장).
  pendingPollMs: num('PENDING_POLL_MS', 5_000),
  // 리버스 프록시 idle 타임아웃에 끊기지 않도록 보내는 SSE 주석 간격(계약 7.1).
  pingMs: num('PING_MS', 15_000),
}
