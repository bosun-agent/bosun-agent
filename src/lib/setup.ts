// 첫 실행 설정 화면이 부르는 WEB 백엔드(server/setup.ts).
// 목업(데모) 빌드에는 백엔드가 없으므로 화면이 usingMock으로 먼저 걸러낸다(src/lib/agent.ts).

import { apiFetch } from './api'

export type SetupCheck = { ok: boolean; message: string }

export type SetupStatus = {
  // 값 세 개가 다 있으면 false. 화면은 이것으로 첫 설정 페이지를 띄울지 정한다.
  needsSetup: boolean
  // env 파일에 쓸 수 있는 상태인지. false면 화면에서 저장할 수 없다.
  writable: boolean
  openrouter: { name: string; set: boolean }
  portainer: { urlName: string; urlSet: boolean; url: string | null; keySet: boolean }
  // 브라우저가 여는 Portainer 주소(WEB 환경변수). 설치할 때 정하므로 화면에서 바꾸지 못한다.
  browserUrl: string | null
  agent: { state: string }
  portainerUrlHint: string
}

export type SetupInput = {
  openrouterKey?: string
  portainerUrl?: string
  portainerApiKey?: string
}

export type SetupOutcome =
  | { ok: true; status: SetupStatus; restart: string; ready: boolean; checks: Record<string, SetupCheck> }
  // 항목 이름(openrouterKey·portainerUrl·portainerApiKey·form) → 이유
  | { ok: false; fields: Record<string, string> }

// 백엔드에 붙지 못하면 null. 화면을 막지 않는다(설정 화면 없이 쓰던 사람을 막으면 안 된다).
export async function getSetupStatus(): Promise<SetupStatus | null> {
  try {
    const res = await apiFetch('/api/setup/status')
    if (!res.ok) return null
    return (await res.json()) as SetupStatus
  } catch {
    return null
  }
}

export async function applySetup(input: SetupInput): Promise<SetupOutcome> {
  const res = await apiFetch('/api/setup', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => null)) as
    | {
        ok?: boolean
        status?: SetupStatus
        restart?: string
        ready?: boolean
        checks?: Record<string, SetupCheck>
        message?: string
        fields?: Record<string, string>
      }
    | null
  if (res.ok && body?.ok && body.status) {
    return { ok: true, status: body.status, restart: body.restart ?? 'started', ready: body.ready === true, checks: body.checks ?? {} }
  }
  if (body?.fields) return { ok: false, fields: body.fields }
  return { ok: false, fields: { form: body?.message ?? `저장하지 못했어요 (HTTP ${res.status}).` } }
}
