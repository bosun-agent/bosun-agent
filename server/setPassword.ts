// 관리자 비밀번호를 정한다. 사용: npm run set-password -- <env 파일>
// env 파일의 ADMIN_PASSWORD_HASH를 바꾸고, JWT_SECRET·ADMIN_USERNAME이 없으면 넣는다.
// 비밀번호 자체는 어디에도 저장하지 않는다. JWT_SECRET을 바꾸지 않으므로 이미 로그인한 세션은 유지된다.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { hashPassword } from './auth.ts'

const file = process.argv[2]
if (!file) {
  console.error('사용: npm run set-password -- <env 파일>')
  process.exit(1)
}

// 터미널이면 입력을 화면에 보이지 않는다. 파이프로 받으면 한 줄씩 읽는다.
function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl)
      ;(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => write(s.startsWith(question) ? s : '')
    }
    rl.question(question, (answer) => {
      rl.close()
      if (process.stdin.isTTY) process.stdout.write('\n')
      resolve(answer)
    })
  })
}

const password = await ask('새 비밀번호(12자 이상): ')
if (password.length < 12) {
  console.error('12자 이상이어야 해요.')
  process.exit(1)
}
if (process.stdin.isTTY && (await ask('한 번 더: ')) !== password) {
  console.error('두 번 입력한 값이 달라요.')
  process.exit(1)
}

const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []
const has = (key: string) => lines.some((l) => l.startsWith(`${key}=`))
const out = lines.filter((l) => !l.startsWith('ADMIN_PASSWORD_HASH='))
while (out.length > 0 && out.at(-1)!.trim() === '') out.pop()
if (!has('ADMIN_USERNAME')) out.push('ADMIN_USERNAME=admin')
out.push(`ADMIN_PASSWORD_HASH=${hashPassword(password)}`)
if (!has('JWT_SECRET')) out.push(`JWT_SECRET=${randomBytes(32).toString('hex')}`)
writeFileSync(file, `${out.join('\n')}\n`, { mode: 0o600 })
console.info(`${file}에 저장했어요. WEB 백엔드를 다시 시작하면 적용돼요.`)
