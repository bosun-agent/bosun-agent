// 개발용: WEB 백엔드가 Agent를 띄우고 다시 시작하는 흐름을 가짜 Agent로 확인한다(server/agentProcess.ts).
// AGENT_BIN=server/dev/fakeAgentBin.ts로 두면 백엔드가 `serve api ... -l <주소>` 인자로 이 파일을 띄운다.
// -l 주소에서 가짜 Agent(fakeUpstream.ts)를 연다. 나머지 인자는 진짜 docker-agent처럼 받기만 한다.
// FAKE_AGENT_EXIT_MS를 주면 그 시간 뒤에 스스로 끝난다(죽었을 때 다시 띄우는지 확인용).

const args = process.argv.slice(2)
// 진짜 docker-agent처럼 `version`에 답한다(WEB이 /health 대신 이 값으로 버전을 보여준다).
if (args[0] === 'version') {
  console.info('docker-agent version v0.0.0-fake')
  process.exit(0)
}
const listen = args[args.indexOf('-l') + 1]
if (args[0] !== 'serve' || args[1] !== 'api' || !listen) {
  console.error('usage: fakeAgentBin serve api <agent.yaml> ... -l <host:port>')
  process.exit(2)
}
process.env.AGENT_URL = `http://${listen}`
await import('./fakeUpstream.ts')

const exitMs = Number(process.env.FAKE_AGENT_EXIT_MS ?? 0)
if (exitMs > 0) setTimeout(() => process.exit(3), exitMs)
