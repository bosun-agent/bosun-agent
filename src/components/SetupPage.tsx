// 첫 실행 설정 페이지. 값이 비어 있으면 채팅 화면 대신 이 화면을 보여준다(App.tsx).
// WEB은 열쇠를 만들어 내지 않는다. 사용자가 직접 발급받아 넣는다:
//   OpenRouter 키: openrouter.ai → Keys
//   Portainer 주소: 컨테이너 스택이면 https://portainer:9443
//   Portainer API 키: Portainer → My account → Access tokens
// 넣은 값은 백엔드가 실제로 확인한다(OpenRouter 401, Portainer /api/endpoints). 틀린 키는 저장되지 않는다.
// 값이 하나라도 남아 있으면 저장이 됐더라도 이 화면에 머문다(빈 채로 대화를 시작하지 않게).

import { useState } from 'react'
import { applySetup, type SetupCheck, type SetupStatus } from '../lib/setup'

type Props = {
  status: SetupStatus
  onDone: () => void
}

type FieldKey = 'openrouterKey' | 'portainerUrl' | 'portainerApiKey'

// 아직 비어 있는 값의 이름. 화면과 안내문에 쓴다.
function missingValues(status: SetupStatus): string[] {
  return [
    !status.openrouter.set ? status.openrouter.name : null,
    !status.portainer.urlSet ? status.portainer.urlName : null,
    !status.portainer.keySet ? 'PORTAINER_API_KEY' : null,
  ].filter((v): v is string => v !== null)
}

function Field({
  id,
  label,
  hint,
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
  hint: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  error?: string
  alreadySet: boolean
  secret?: boolean
  disabled: boolean
}) {
  return (
    <label htmlFor={id} className="block">
      <span className="flex items-center gap-2 text-sm font-medium text-neutral-800">
        {label}
        {alreadySet && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">이미 설정됨</span>}
      </span>
      <span className="mt-1 block text-xs text-neutral-500">{hint}</span>
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
    </label>
  )
}

export function SetupPage({ status, onDone }: Props) {
  const [current, setCurrent] = useState(status)
  const [openrouterKey, setOpenrouterKey] = useState('')
  const [portainerUrl, setPortainerUrl] = useState('')
  const [portainerApiKey, setPortainerApiKey] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<{ ready: boolean; note: string } | null>(null)

  const missing = missingValues(current)

  async function submit() {
    setBusy(true)
    setFields({})
    const outcome = await applySetup({
      ...(openrouterKey.trim() ? { openrouterKey: openrouterKey.trim() } : {}),
      ...(portainerUrl.trim() ? { portainerUrl: portainerUrl.trim() } : {}),
      ...(portainerApiKey.trim() ? { portainerApiKey: portainerApiKey.trim() } : {}),
    })
    setBusy(false)
    if (!outcome.ok) {
      setFields(outcome.fields)
      return
    }
    setCurrent(outcome.status)
    const left = missingValues(outcome.status)
    // 넣은 값이 저장되긴 했지만 아직 빈 값이 남았으면 여기서 더 받는다.
    if (left.length > 0) {
      setFields({ form: `저장했어요. 아직 없는 값: ${left.join(', ')}` })
      setOpenrouterKey('')
      setPortainerApiKey('')
      return
    }
    setSaved({ ready: outcome.ready, note: noteFor(outcome.checks) })
    setOpenrouterKey('')
    setPortainerApiKey('')
  }

  if (saved) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-lg rounded-lg border border-neutral-200 p-6 text-sm">
          <h1 className="text-base font-semibold text-neutral-900">설정을 저장했어요</h1>
          <p className="mt-2 text-neutral-600">
            {saved.ready
              ? 'Agent가 새 값으로 다시 시작했고 준비됐어요. 이제 대화를 시작할 수 있어요.'
              : 'Agent를 다시 시작하는 중이에요. 화면 위쪽 상태 표시가 준비됨으로 바뀌면 대화를 시작할 수 있어요.'}
          </p>
          {saved.note && <p className="mt-2 text-xs text-neutral-500">{saved.note}</p>}
          <button
            type="button"
            onClick={onDone}
            className="mt-4 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
          >
            시작하기
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-lg border border-neutral-200 p-6">
        <h1 className="text-base font-semibold text-neutral-900">처음 설정</h1>
        <p className="mt-2 text-sm text-neutral-600">
          BOSUN은 열쇠를 만들어 주지 않아요. 아래 값은 직접 발급받아 넣어 주세요.
        </p>
        {missing.length > 0 && (
          <p className="mt-2 text-xs text-neutral-500">
            아직 없는 값: <span className="font-mono">{missing.join(', ')}</span>
          </p>
        )}
        {!current.portainer.keySet && current.browserUrl && (
          <p className="mt-2 text-xs text-neutral-500">
            Portainer 관리자 계정이 아직 없다면 먼저 만들어 주세요:{' '}
            <a href={current.browserUrl} target="_blank" rel="noreferrer" className="underline">
              {current.browserUrl}
            </a>{' '}
            → 초기 설정 → My account → Access tokens에서 키를 만듭니다.
          </p>
        )}

        <div className="mt-5 space-y-4">
          <Field
            id="openrouterKey"
            label="OpenRouter API 키"
            hint="openrouter.ai → Keys에서 만든 키(sk-or-…). 모델 호출에 씁니다."
            placeholder="sk-or-v1-…"
            value={openrouterKey}
            onChange={setOpenrouterKey}
            error={fields.openrouterKey}
            alreadySet={current.openrouter.set}
            secret
            disabled={busy || !current.writable}
          />
          <Field
            id="portainerUrl"
            label="Portainer 주소"
            hint="Portainer를 설치한 곳의 주소예요. 컨테이너에서도 닿는 주소여야 해요(예: https://10.0.11.177:9443)."
            placeholder={current.portainer.url ?? current.portainerUrlHint}
            value={portainerUrl}
            onChange={setPortainerUrl}
            error={fields.portainerUrl}
            alreadySet={current.portainer.urlSet}
            disabled={busy || !current.writable}
          />
          <Field
            id="portainerApiKey"
            label="Portainer API 키"
            hint="Portainer → My account → Access tokens에서 만든 키(ptr-…)."
            placeholder="ptr-…"
            value={portainerApiKey}
            onChange={setPortainerApiKey}
            error={fields.portainerApiKey}
            alreadySet={current.portainer.keySet}
            secret
            disabled={busy || !current.writable}
          />
        </div>

        {fields.form && <p className="mt-3 text-xs text-neutral-600">{fields.form}</p>}
        {!current.writable && (
          <p className="mt-3 text-xs text-red-600">
            값을 저장할 수 없어요. 설치할 때 Agent env 파일 경로(AGENT_ENV_FILE)를 넣어 주세요.
          </p>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={busy || !current.writable}
          className="mt-5 w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:bg-neutral-400"
        >
          {busy ? '확인하고 저장하는 중…' : '확인하고 저장'}
        </button>
        <p className="mt-2 text-xs text-neutral-500">
          저장 전에 실제로 확인해요: 값이 틀리면 저장되지 않고 이유를 알려줘요.
        </p>
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
