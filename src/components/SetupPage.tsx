// 첫 실행 설정 페이지. 값이 비어 있으면 채팅 화면 대신 이 화면을 보여준다(App.tsx).
// 사용자는 키 두 개(OpenRouter, Portainer)만 넣는다. 설명은 제목 옆 ? 하나에 모았다(2026-11-14 사용자 결정).
// Portainer 주소는 칸을 숨기고 기본값을 보낸다(PORTAINER_URL_INTERNAL → PORTAINER_URL → https://localhost:9443).
// 그 주소로 Portainer가 응답하지 않으면 백엔드가 portainerUrl 오류를 돌려주고, 그때만 주소 칸을 보여준다.
// 넣은 값은 백엔드가 실제로 확인한다(OpenRouter 401, Portainer /api/endpoints). 틀린 키는 저장되지 않는다.

import { useState } from 'react'
import { applySetup, type SetupCheck, type SetupStatus } from '../lib/setup'

type Props = {
  status: SetupStatus
  onDone: () => void
  // 화면에서 직접 연 경우에만 있다(채팅으로 돌아가기). 첫 실행일 때는 없다.
  onClose?: () => void
}

type FieldKey = 'openrouterKey' | 'portainerUrl' | 'portainerApiKey'

const LOCAL_PORTAINER_URL = 'https://localhost:9443'

// 아직 비어 있는 값의 이름.
function missingValues(status: SetupStatus): string[] {
  return [
    !status.openrouter.set ? status.openrouter.name : null,
    !status.portainer.urlSet ? status.portainer.urlName : null,
    !status.portainer.keySet ? 'PORTAINER_API_KEY' : null,
  ].filter((v): v is string => v !== null)
}

// 주소를 따로 안 넣었을 때 보낼 값. 컨테이너 설치는 PORTAINER_URL_INTERNAL(portainerUrlHint에 실린다), 아니면 브라우저용 주소.
function defaultPortainerUrl(status: SetupStatus): string {
  const internal = status.portainerUrlHint.includes('<') ? null : status.portainerUrlHint
  return internal ?? status.browserUrl ?? LOCAL_PORTAINER_URL
}

function Field({
  id,
  label,
  placeholder,
  value,
  onChange,
  error,
  alreadySet,
  secret,
  disabled,
}: {
  id: FieldKey
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  error?: string
  alreadySet: boolean
  secret?: boolean
  disabled: boolean
}) {
  return (
    <div>
      <span className="flex items-center gap-2 text-sm font-medium text-neutral-800">
        <label htmlFor={id}>{label}</label>
        {alreadySet && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">이미 설정됨</span>}
      </span>
      <input
        id={id}
        type={secret ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={alreadySet && secret ? '바꾸려면 새 값을 넣으세요' : placeholder}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className={`mt-1 w-full rounded-md border px-3 py-2 font-mono text-sm outline-none focus:border-neutral-500 disabled:bg-neutral-50 ${
          error ? 'border-red-400' : 'border-neutral-300'
        }`}
      />
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </div>
  )
}

// 제목 옆 ? 하나에 모은 설명. 키 받는 법, 주소, 어떻게 전달되는지.
function HelpBox({ portainerUrl, browserUrl }: { portainerUrl: string; browserUrl: string | null }) {
  const portainerLink = browserUrl ?? LOCAL_PORTAINER_URL
  return (
    <div className="mt-3 space-y-3 rounded-lg bg-sky-50 px-4 py-3 text-xs leading-relaxed text-neutral-700">
      <section>
        <p className="font-semibold text-navy-900">OpenRouter API 키 (sk-or-v1-…)</p>
        <ol className="mt-0.5 list-decimal space-y-0.5 pl-4">
          <li>
            <a href="https://openrouter.ai" target="_blank" rel="noreferrer" className="underline">
              openrouter.ai
            </a>
            에 가입하고 로그인해요.
          </li>
          <li>오른쪽 위 메뉴 → Keys → Create Key. 사용 한도(credit limit)를 정해 두면 안전해요.</li>
          <li>키는 한 번만 보여요. 바로 복사해서 붙여 넣어요.</li>
          <li>유료 모델은 크레딧 충전이 필요하고, 이름에 :free가 붙은 모델은 충전 없이 돼요.</li>
        </ol>
      </section>
      <section>
        <p className="font-semibold text-navy-900">Portainer API 키 (ptr_…)</p>
        <ol className="mt-0.5 list-decimal space-y-0.5 pl-4">
          <li>
            <a href={portainerLink} target="_blank" rel="noreferrer" className="underline">
              Portainer
            </a>
            에 로그인해요(처음이면 관리자 계정부터 만들어요).
          </li>
          <li>오른쪽 위 사용자 이름 → My account → Access tokens → Add access token.</li>
          <li>이름(예: bosun)과 지금 비밀번호를 넣으면 키가 한 번만 보여요. 바로 복사해요.</li>
        </ol>
      </section>
      <section>
        <p className="font-semibold text-navy-900">Portainer 주소</p>
        <p className="mt-0.5">
          따로 넣지 않아도 <span className="font-mono">{portainerUrl}</span>로 연결해요(이 PC의 Portainer). 연결이 안 되면 주소 칸이 나타나요.
        </p>
      </section>
      <section>
        <p className="font-semibold text-navy-900">키는 어떻게 전달되나요</p>
        <p className="mt-0.5">
          저장하기 전에 OpenRouter와 Portainer에 키가 맞는지 먼저 물어보고, 틀리면 아무것도 저장하지 않아요. 맞으면 이 PC의 Agent 설정
          파일(agent.env)에만 저장하고 AI Agent를 다시 시작해요. AI Agent는 모델을 부를 때 OpenRouter 키를, Docker를 다룰 때 Portainer
          키를 붙여 보내요. 키는 화면에 다시 보여주지 않고 저장소(git)에도 올라가지 않아요. Portainer 키는 만든 계정의 권한을 그대로
          가져서, 위험한 작업은 BOSUN 정책 검사와 승인 카드가 한 번 더 막아요.
        </p>
      </section>
    </div>
  )
}

export function SetupPage({ status, onDone, onClose }: Props) {
  const [current, setCurrent] = useState(status)
  const [openrouterKey, setOpenrouterKey] = useState('')
  const [portainerApiKey, setPortainerApiKey] = useState('')
  // 주소는 평소엔 숨긴다. 기본 주소로 연결이 안 되면(portainerUrl 오류) 칸을 보여주고 고친 값을 보낸다.
  const [portainerUrl, setPortainerUrl] = useState(() => defaultPortainerUrl(status))
  const [showUrl, setShowUrl] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<{ ready: boolean; note: string; notice?: string } | null>(null)

  async function submit() {
    setBusy(true)
    setFields({})
    // 주소가 아직 없거나 사용자가 고친 경우에만 보낸다. 이미 저장된 주소는 그대로 둔다.
    const sendUrl = !current.portainer.urlSet || showUrl
    const outcome = await applySetup({
      ...(openrouterKey.trim() ? { openrouterKey: openrouterKey.trim() } : {}),
      ...(sendUrl && portainerUrl.trim() ? { portainerUrl: portainerUrl.trim() } : {}),
      ...(portainerApiKey.trim() ? { portainerApiKey: portainerApiKey.trim() } : {}),
    })
    setBusy(false)
    if (!outcome.ok) {
      setFields(outcome.fields)
      if (outcome.fields.portainerUrl) setShowUrl(true)
      return
    }
    setCurrent(outcome.status)
    setOpenrouterKey('')
    setPortainerApiKey('')
    const left = missingValues(outcome.status)
    // 넣은 값이 저장되긴 했지만 아직 빈 칸이 남았으면 여기서 더 받는다.
    if (left.length > 0) {
      setFields({ form: '저장했어요. 남은 키도 넣어 주세요.' })
      return
    }
    setSaved({ ready: outcome.ready, note: noteFor(outcome.checks), ...(outcome.notice ? { notice: outcome.notice } : {}) })
  }

  const title = onClose ? '연결 설정' : '처음 설정'

  if (saved) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-lg rounded-lg border border-neutral-200 p-6 text-sm">
          <h1 className="text-base font-semibold text-neutral-900">{title}을 저장했어요</h1>
          <p className="mt-2 text-neutral-600">
            {saved.ready
              ? 'Agent가 새 값으로 다시 시작했고 준비됐어요. 이제 대화를 시작할 수 있어요.'
              : 'Agent를 다시 시작하는 중이에요. 화면 위쪽 상태 표시가 준비됨으로 바뀌면 대화를 시작할 수 있어요.'}
          </p>
          {saved.note && <p className="mt-2 text-xs text-neutral-500">{saved.note}</p>}
          {saved.notice && <p className="mt-2 text-xs text-amber-700">{saved.notice}</p>}
          <button
            type="button"
            onClick={onDone}
            className="mt-4 rounded-md bg-navy-800 px-4 py-2 text-sm font-medium text-white hover:bg-navy-700"
          >
            {onClose ? '닫기' : '시작하기'}
          </button>
        </div>
      </div>
    )
  }

  const disabled = busy || !current.writable

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-lg border border-neutral-200 p-6">
        <div className="mb-4 flex items-center gap-2 text-navy-900">
          <img src="/favicon.png" alt="" width={28} height={28} className="h-7 w-7 rounded-full bg-white ring-1 ring-neutral-300" draggable={false} />
          <span className="font-display text-[22px] leading-none tracking-[0.04em]">BOSUN</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-neutral-900">{title}</h1>
            <button
              type="button"
              onClick={() => setHelpOpen((v) => !v)}
              aria-label="키 받는 법과 전달 방식"
              aria-expanded={helpOpen}
              title="키는 어디서 받고 어디로 가나요?"
              className={`flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors ${
                helpOpen ? 'border-navy-700 bg-navy-700 text-white' : 'border-neutral-400 text-neutral-600 hover:border-navy-600 hover:text-navy-700'
              }`}
            >
              ?
            </button>
          </span>
          {onClose && (
            <button type="button" onClick={onClose} className="shrink-0 text-sm text-neutral-500 hover:text-neutral-800">
              돌아가기
            </button>
          )}
        </div>
        {helpOpen && <HelpBox portainerUrl={portainerUrl} browserUrl={current.browserUrl} />}
        {current.warnings && current.warnings.length > 0 && (
          <p className="mt-2 text-xs text-amber-700">
            값이 빈 줄로 남아 있어요: <span className="font-mono">{current.warnings.join(', ')}</span> — 저장하면 그 줄은 지워져요.
          </p>
        )}

        <div className="mt-5 space-y-4">
          <Field
            id="openrouterKey"
            label="OpenRouter API 키"
            placeholder="sk-or-v1-…"
            value={openrouterKey}
            onChange={setOpenrouterKey}
            error={fields.openrouterKey}
            alreadySet={current.openrouter.set}
            secret
            disabled={disabled}
          />
          <Field
            id="portainerApiKey"
            label="Portainer API 키"
            placeholder="ptr_…"
            value={portainerApiKey}
            onChange={setPortainerApiKey}
            error={fields.portainerApiKey}
            alreadySet={current.portainer.keySet}
            secret
            disabled={disabled}
          />
          {showUrl && (
            <Field
              id="portainerUrl"
              label="Portainer 주소"
              placeholder={LOCAL_PORTAINER_URL}
              value={portainerUrl}
              onChange={setPortainerUrl}
              error={fields.portainerUrl}
              alreadySet={false}
              disabled={disabled}
            />
          )}
        </div>

        {fields.form && <p className="mt-3 text-xs text-neutral-600">{fields.form}</p>}
        {!current.writable && (
          <p className="mt-3 text-xs text-red-600">값을 저장할 수 없어요. 설치할 때 Agent env 파일 경로(AGENT_ENV_FILE)를 넣어 주세요.</p>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          className="mt-5 w-full rounded-md bg-navy-800 px-4 py-2 text-sm font-medium text-white hover:bg-navy-700 disabled:bg-neutral-400"
        >
          {busy ? '확인하고 저장하는 중…' : '확인하고 저장'}
        </button>
      </div>
    </div>
  )
}

// 확인 결과를 한 줄로. 자체 서명 인증서는 정상적인 컨테이너 설치라 안내만 남긴다.
function noteFor(checks: Record<string, SetupCheck>): string {
  const parts: string[] = []
  if (checks.openrouter?.ok) parts.push(checks.openrouter.message)
  const portainer = checks.portainer
  if (portainer?.ok) parts.push(portainer.message)
  return parts.join(' ')
}

export default SetupPage
