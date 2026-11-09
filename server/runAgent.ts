// npm run agent: Docker Agent만 따로 띄운다. 값은 WEB 백엔드와 같은 server/real.env에서 읽는다.
// 보통은 필요 없다. AGENT_BIN이 있으면 `npm start`가 Agent를 같이 띄운다(server/agentProcess.ts).
// Agent 로그만 따로 보고 싶을 때 쓴다. 이렇게 띄운 Agent는 WEB이 다시 시작할 수 없다(API 키를 바꾸면 이 창을 다시 띄운다).
// - AGENT_BIN: docker-agent 실행 파일(v1.148.0 이상). 없으면 PATH의 docker-agent.
// - AGENT_ENV_FILE: Agent --env-from-file(API 키·Portainer 키). agent.yaml(<AGENT_NAME>.yaml)과 session.db는 이 파일과 같은 폴더에 둔다.
//   다른 곳에 두면 AGENT_CONFIG, AGENT_SESSION_DB로 정한다.
// - AGENT_TOKEN: --auth-token. WEB 백엔드가 같은 값으로 붙는다.
// - AGENT_URL: 듣는 주소(기본 127.0.0.1:17080).

import { spawn } from 'node:child_process'
import { agentCommand } from './agentProcess.ts'

function fail(message: string): never {
  console.error(`[agent] ${message}`)
  process.exit(1)
}

const cmd = agentCommand()
if (typeof cmd === 'string') fail(cmd)

console.info(`[agent] ${cmd.describe}`)
const child = spawn(cmd.bin, cmd.args, { stdio: 'inherit' })
child.on('error', (err) => fail(`${cmd.bin}를 실행하지 못했어요: ${err.message}. server/real.env의 AGENT_BIN을 확인해주세요.`))
child.on('exit', (code) => process.exit(code ?? 0))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
