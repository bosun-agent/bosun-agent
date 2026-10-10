// WEB 백엔드 호출. 로그인 쿠키(HttpOnly)는 브라우저가 알아서 붙인다.
// 모든 요청에 X-Bosun 헤더를 붙인다. 상태를 바꾸는 요청은 이 헤더가 없으면 백엔드가 거절한다(server/auth.ts).
// 401이 오면 로그인이 끝난 것이다. 화면에 알려서 로그인 화면으로 돌린다(AuthGate).

export const UNAUTHORIZED_EVENT = 'bosun:unauthorized'

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('X-Bosun', '1')
  const res = await fetch(path, { ...init, headers })
  if (res.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  return res
}

// 로그인돼 있으면 사용자 이름, 아니면 null
export async function currentUser(): Promise<string | null> {
  const res = await apiFetch('/api/auth/me')
  if (!res.ok) return null
  return ((await res.json()) as { username: string }).username
}

export async function login(username: string, password: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await apiFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).catch(() => null)
  if (res?.ok) return { ok: true }
  const body = (await res?.json().catch(() => null)) as { message?: string } | null
  return { ok: false, message: body?.message ?? '서버에 연결하지 못했어요.' }
}

export async function logout(): Promise<void> {
  await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined)
}
