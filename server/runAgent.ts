// npm run agent: 실제 연동용 Docker Agent를 띄운다. 값은 WEB 백엔드와 같은 server/real.env에서 읽는다.
// - AGENT_BIN: docker-agent 실행 파일(v1.148.0 이상). 없으면 PATH의 docker-agent.
//   Docker Desktop에 든 플러그인(docker agent)은 버전이 낮으면 agent.yaml의 safety 같은 키를 읽지 못한다.
// - AGENT_ENV_FILE: Agent --env-from-file(API 키·Portainer 키). agent.yaml(<AGENT_NAME>.yaml)과 session.db는 이 파일과 같은 폴더에 둔다.
//   다른 곳에 두면 AGENT_CONFIG, AGENT_SESSION_DB로 정한다.
// - AGENT_TOKEN: --auth-token. WEB 백엔드가 같은 값으로 붙는다.
// - AGENT_URL: 듣는 주소(기본 127.0.0.1:8080).

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { config } from './config.ts'

function fail(message: string): never {
  console.error(`[agent] ${message}`)
  process.exit(1)
}

if (!config.agentEnvFile) fail('AGENT_ENV_FILE이 없어요. server/real.env에 Agent env 파일 경로를 넣어주세요.')
const dir = dirname(config.agentEnvFile)
const bin = process.env.AGENT_BIN || 'docker-agent'
const agentYaml = process.env.AGENT_CONFIG || join(dir, `${config.agentName}.yaml`)
const sessionDb = process.env.AGENT_SESSION_DB || join(dir, 'session.db')
if (!existsSync(agentYaml)) fail(`Agent 설정 파일이 없어요: ${agentYaml} (AGENT_NAME이나 AGENT_CONFIG를 확인해주세요)`)

const listen = new URL(config.agentUrl).host
const args = ['serve', 'api', agentYaml, '--env-from-file', config.agentEnvFile, '--session-db', sessionDb, '-l', listen]
if (config.agentToken) args.push('--auth-token', config.agentToken)

// 토큰은 화면에 찍지 않는다.
console.info(`[agent] ${bin} serve api ${agentYaml} (listen ${listen}, session ${sessionDb})`)
const child = spawn(bin, args, { stdio: 'inherit' })
child.on('error', (err) => fail(`${bin}를 실행하지 못했어요: ${err.message}. server/real.env의 AGENT_BIN을 확인해주세요.`))
child.on('exit', (code) => process.exit(code ?? 0))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
