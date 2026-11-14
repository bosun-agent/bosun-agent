// WEB 백엔드 호출.
// 모든 요청에 X-Bosun 헤더를 붙인다. 상태를 바꾸는 요청은 이 헤더가 없으면 백엔드가 거절한다(server/guard.ts).

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('X-Bosun', '1')
  return fetch(path, { ...init, headers })
}
