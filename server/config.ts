// WEB 백엔드 설정. 주소와 비밀값은 환경변수로 받는다.
// 연동 전에 받을 값은 인터페이스 계약 7장에 있다.

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
  // 설정 화면에서 고를 수 있는 모델. 쉼표로 나눈 `provider/model` 또는 agent.yaml models의 이름.
  // 비어 있으면 모델을 고르지 않고 agent.yaml에 적힌 모델을 쓴다.
  agentModels: (process.env.AGENT_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean),

  // Docker Agent `--env-from-file`로 넘기는 env 파일. 설정 화면에서 API 키를 바꾸면 이 파일에 쓴다(계약 7장 ①).
  // 비어 있으면 화면에서 키를 바꿀 수 없다. 저장한 키는 Agent를 다시 시작해야 적용된다.
  agentEnvFile: process.env.AGENT_ENV_FILE ?? '',
  // 그 파일에서 바꿀 키 이름. agent.yaml 모델의 provider에 맞춘다.
  agentKeyName: process.env.AGENT_KEY_NAME ?? 'OPENROUTER_API_KEY',

  // 로그인(관리자 한 명, server/auth.ts). 비밀번호 해시와 서명 키는 `npm run set-password -- <env 파일>`로 만든다.
  adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? '',
  jwtSecret: process.env.JWT_SECRET ?? '',
  sessionHours: num('SESSION_HOURS', 12),
  // HTTPS가 아닌 곳(로컬 개발)에서만 0으로 둔다. 기본은 Secure 쿠키다.
  cookieSecure: process.env.COOKIE_SECURE !== '0',

  // 승인·차단 카드와 승인 감사 기록을 두는 SQLite 파일. 대화 내용은 Docker Agent session.db에 있다.
  dbPath: process.env.WEB_DB_PATH ?? 'server/data/web.db',

  // 승인 카드를 띄운 뒤 이 시간이 지나면 거부한다. Docker Agent는 승인을 무기한 기다리므로 WEB이 정한다(계약 6장).
  approvalTimeoutMs: num('APPROVAL_TIMEOUT_MS', 300_000),
  // 브라우저가 만료 거부를 먼저 보낼 수 있게, 서버 쪽 자동 거부는 expiresAt보다 조금 늦게 한다.
  expiryGraceMs: num('EXPIRY_GRACE_MS', 3_000),
  // 리버스 프록시 idle 타임아웃에 끊기지 않도록 보내는 SSE 주석 간격(계약 7.1).
  pingMs: num('PING_MS', 15_000),
}
