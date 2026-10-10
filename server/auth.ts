// 로그인. MVP는 관리자 한 명이다(D4 A-1, 계약 3장·5장).
// - 계정은 환경변수로 정한다. ADMIN_USERNAME(기본 admin), ADMIN_PASSWORD_HASH(scrypt, `npm run set-password`로 만든다).
// - 로그인하면 JWT(HS256)를 HttpOnly 쿠키로 준다. 화면 스크립트가 토큰을 읽을 수 없으므로,
//   화면에 섞인 외부 문자열이 스크립트로 실행되더라도 토큰은 새지 않는다.
// - 쿠키는 SameSite=Strict다. 상태를 바꾸는 요청에는 `X-Bosun: 1` 헤더도 요구한다.
//   다른 사이트는 이 헤더를 붙여 보낼 수 없다(CORS 사전 요청을 WEB이 허락하지 않는다).

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { sign, verify } from 'hono/jwt'
import { config } from './config.ts'

export type AuthEnv = { Variables: { user: string } }

const COOKIE = 'bosun_session'
const CSRF_HEADER = 'x-bosun'

// ---- 비밀번호 ----

const SCRYPT = { N: 16384, r: 8, p: 1 }

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, SCRYPT)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

function checkPassword(password: string, stored: string): boolean {
  const [kind, n, r, p, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) })
  return timingSafeEqual(actual, expected)
}

// 연속으로 틀리면 잠깐 막는다. 관리자 한 명이고 루프백에서만 열기 때문에 IP별로 나누지 않는다.
const MAX_FAILURES = 5
const LOCK_MS = 30_000
let failures = 0
let lockedUntil = 0

export type LoginResult = { ok: true } | { ok: false; locked: boolean }

export function checkLogin(username: unknown, password: unknown): LoginResult {
  if (Date.now() < lockedUntil) return { ok: false, locked: true }
  // 아이디가 틀려도 비밀번호 검사는 한다. 응답 시간으로 아이디를 알아내지 못하게.
  const passOk = typeof password === 'string' && checkPassword(password, config.adminPasswordHash)
  const userOk = typeof username === 'string' && username === config.adminUsername
  if (passOk && userOk) {
    failures = 0
    return { ok: true }
  }
  failures++
  if (failures >= MAX_FAILURES) {
    failures = 0
    lockedUntil = Date.now() + LOCK_MS
  }
  return { ok: false, locked: false }
}

// ---- 세션 쿠키 ----

export async function startSession(c: Context, username: string): Promise<void> {
  const ttl = config.sessionHours * 3600
  const token = await sign({ sub: username, exp: Math.floor(Date.now() / 1000) + ttl }, config.jwtSecret, 'HS256')
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Strict',
    path: '/api',
    maxAge: ttl,
  })
}

export function endSession(c: Context): void {
  deleteCookie(c, COOKIE, { path: '/api', secure: config.cookieSecure })
}

async function sessionUser(c: Context): Promise<string | null> {
  const token = getCookie(c, COOKIE)
  if (!token) return null
  try {
    const payload = await verify(token, config.jwtSecret, 'HS256')
    return typeof payload.sub === 'string' && payload.sub === config.adminUsername ? payload.sub : null
  } catch {
    return null
  }
}

// /api 전체에 건다. 로그인 요청만 쿠키 없이 통과한다.
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header(CSRF_HEADER) !== '1') {
    return c.json({ error: 'FORBIDDEN', message: '허용되지 않은 요청이에요.' }, 403)
  }
  if (c.req.path === '/api/auth/login') return next()
  const user = await sessionUser(c)
  if (!user) return c.json({ error: 'UNAUTHORIZED', message: '로그인이 필요해요.' }, 401)
  c.set('user', user)
  return next()
}
