// WEB 백엔드 설정. 주소와 비밀값은 환경변수로 받는다.

import { dirname, join } from 'node:path'

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number: ${raw}`)
  return value
}

export const config = {
  // 브라우저(Vite 개발 서버 프록시)가 붙는 주소. 로그인이 없으므로 루프백에서만 연다(main.ts).
  host: process.env.HOST ?? '127.0.0.1',
  // 컨테이너 안에서만 1로 둔다. 컨테이너 안은 0.0.0.0으로 열고, 밖에서는 `-p 127.0.0.1:...`로만 내보낸다(Dockerfile).
  inContainer: process.env.HOST_IN_CONTAINER === '1',
  port: num('PORT', 3001),

  // Docker Agent API 서버(`docker agent serve api`). 기본 주소는 Agent 담당 확인값.
  // 8080은 사용자 앱이 흔히 쓰는 포트라 겹친다(2026-11-09 실측: nginx 스택과 공존하며 주소에 따라 다른 쪽이 응답).
  agentUrl: process.env.AGENT_URL ?? 'http://127.0.0.1:17080',
  // POST /api/sessions/:id/agent/:agent의 :agent. Docker Agent의 GET /api/agents로 확인한다.
  agentName: process.env.AGENT_NAME ?? 'agent',
  // `serve api --auth-token`을 켰을 때만 넣는다.
  agentToken: process.env.AGENT_TOKEN ?? '',
  // docker-agent 실행 파일(v1.148.0 이상). 있으면 WEB 백엔드가 Agent를 띄우고 관리한다(server/agentProcess.ts).
  // Docker Desktop에 든 플러그인(docker agent)은 버전이 낮으면 agent.yaml의 safety 같은 키를 읽지 못한다.
  agentBin: process.env.AGENT_BIN ?? '',
  // agent.yaml과 session.db. 비어 있으면 AGENT_ENV_FILE과 같은 폴더의 <AGENT_NAME>.yaml, session.db.
  agentConfig: process.env.AGENT_CONFIG ?? '',
  agentSessionDb: process.env.AGENT_SESSION_DB ?? '',
  // 설정 화면에서 고를 수 있는 모델. 쉼표로 나눈 `provider/model` 또는 agent.yaml models의 이름.
  // 비어 있으면 모델을 고르지 않고 agent.yaml에 적힌 모델을 쓴다.
  agentModels: (process.env.AGENT_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean),

  // Docker Agent `--env-from-file`로 넘기는 env 파일. 설정 화면에서 API 키를 바꾸면 이 파일에 쓴다.
  // 비어 있으면 화면에서 키를 바꿀 수 없다. 저장한 키는 Agent를 다시 시작해야 적용된다.
  agentEnvFile: process.env.AGENT_ENV_FILE ?? '',
  // 그 파일에서 바꿀 키 이름. agent.yaml 모델의 provider에 맞춘다.
  agentKeyName: process.env.AGENT_KEY_NAME ?? 'OPENROUTER_API_KEY',

  // 승인·차단 카드와 승인 감사 기록을 두는 SQLite 파일. 대화 내용은 Docker Agent session.db에 있다.
  dbPath: process.env.WEB_DB_PATH ?? 'server/data/web.db',

  // 승인 카드를 띄운 뒤 이 시간이 지나면 거부한다. Docker Agent는 승인을 무기한 기다리므로 WEB이 정한다.
  approvalTimeoutMs: num('APPROVAL_TIMEOUT_MS', 300_000),
  // 브라우저가 만료 거부를 먼저 보낼 수 있게, 서버 쪽 자동 거부는 expiresAt보다 조금 늦게 한다.
  expiryGraceMs: num('EXPIRY_GRACE_MS', 3_000),
  // 리버스 프록시 idle 타임아웃에 끊기지 않도록 보내는 SSE 주석 간격.
  pingMs: num('PING_MS', 15_000),
  // 동시에 처리하는 대화 수 상한. 대화마다 Agent 스트림 하나와 모델 호출이 돈다.
  maxTurns: num('MAX_TURNS', 3),
  // 메시지 한 개 최대 길이. 첨부한 파일 내용도 메시지에 들어간다.
  maxMessageChars: num('MAX_MESSAGE_CHARS', 100_000),

  // Agent 백업 훅이 삭제 전에 저장하는 SQLite(읽기만 한다, server/backups.ts). 기본값은 훅과 같다.
  backupDb:
    process.env.BACKUP_DB ??
    (process.env.AGENT_ENV_FILE ? join(dirname(process.env.AGENT_ENV_FILE), 'backups.sqlite3') : ''),

  // 정책에 막힌 작업을 직접 하러 갈 Portainer 화면 주소. 브라우저에서 열리는 주소를 넣는다(Agent의 PORTAINER_URL과 다를 수 있다).
  // 비어 있거나 http(s)가 아니면 차단 안내에 링크 없이 문구만 보여준다.
  portainerUrl: /^https?:\/\/[^\s"'<>]+$/.test(process.env.PORTAINER_URL ?? '') ? process.env.PORTAINER_URL! : '',

  // 빌드한 화면 폴더(npm run build → dist). 정하면 WEB 백엔드가 화면도 내보낸다. 개발 중에는 비워 두고 Vite를 쓴다.
  staticDir: process.env.STATIC_DIR ?? '',
}
