// 로그인은 없다. 이 PC에서만 쓰기 때문이다(10-28 회의, 계약 3장·5장).
// 대신 이 PC의 브라우저 화면만 /api를 부를 수 있게 막는다.
// - 백엔드는 루프백 주소에서만 연다(main.ts). 같은 네트워크의 다른 PC는 붙지 못한다.
// - Host가 localhost·127.0.0.1·[::1]이 아니면 거절한다. 다른 사이트가 DNS 리바인딩으로 자기 도메인을
//   127.0.0.1로 돌려도 Host에는 그 도메인이 남는다. 포트는 보지 않는다(Vite 개발 서버 프록시는 5173을 그대로 넘긴다).
// - Origin이 있으면 그것도 루프백이어야 한다.
// - 상태를 바꾸는 요청에는 `X-Bosun: 1` 헤더를 요구한다. 다른 사이트는 이 헤더를 붙여 보낼 수 없다
//   (CORS 사전 요청을 WEB이 허락하지 않는다).

import type { MiddlewareHandler } from 'hono'

const CSRF_HEADER = 'x-bosun'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

// 승인 감사 기록의 `user`. 로그인이 없으므로 화면에서 누른 결정은 모두 이 값이다(만료 자동 거부는 `system`).
export const LOCAL_USER = 'local'

export function isLoopbackHost(host: string): boolean {
  return host === '::1' || LOOPBACK_HOSTS.has(host)
}

function loopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

const FORBIDDEN = { error: 'FORBIDDEN', message: '이 PC의 BOSUN 화면에서만 쓸 수 있어요.' }

// /api 전체에 건다.
export const localOnly: MiddlewareHandler = async (c, next) => {
  if (!loopbackUrl(`http://${c.req.header('host') ?? ''}`)) return c.json(FORBIDDEN, 403)
  const origin = c.req.header('origin')
  if (origin !== undefined && !loopbackUrl(origin)) return c.json(FORBIDDEN, 403)
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header(CSRF_HEADER) !== '1') {
    return c.json({ error: 'FORBIDDEN', message: '허용되지 않은 요청이에요.' }, 403)
  }
  return next()
}
