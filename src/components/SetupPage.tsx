// 첫 실행 설정 페이지. 값이 비어 있으면 채팅 화면 대신 이 화면을 보여준다(App.tsx).
// WEB은 열쇠를 만들어 내지 않는다. 사용자가 직접 발급받아 넣는다:
//   OpenRouter 키: openrouter.ai → Keys
//   Portainer 주소: 컨테이너 스택이면 https://portainer:9443
//   Portainer API 키: Portainer → My account → Access tokens
// 넣은 값은 백엔드가 실제로 확인한다(OpenRouter 401, Portainer /api/endpoints). 틀린 키는 저장되지 않는다.
// 값이 하나라도 남아 있으면 저장이 됐더라도 이 화면에 머문다(빈 채로 대화를 시작하지 않게).

import { useEffect, useState, type ReactNode } from 'react'
import { agent } from '../lib/agent'
import { applySetup, type SetupCheck, type SetupStatus } from '../lib/setup'

type Props = {
  status: SetupStatus
  onDone: () => void
  // 화면에서 직접 연 경우에만 있다(채팅으로 돌아가기). 첫 실행일 때는 없다.
  onClose?: () => void
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

// 칸 이름 옆 ? 버튼. 누르면 받는 법과 어떻게 전달되는지를 칸 아래에 펼친다(폰에서도 되게 마우스 올리기 대신 누르기).
function HelpButton({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`${label} 받는 법`}
      aria-expanded={open}
      title="어디서 받고 어디로 가나요?"
      className={`flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors ${
        open ? 'border-navy-700 bg-navy-700 text-white' : 'border-neutral-400 text-neutral-600 hover:border-navy-600 hover:text-navy-700'
      }`}
    >
      ?
    </button>
  )
}

type Help = { steps: ReactNode[]; delivery: ReactNode }

function HelpBox({ steps, delivery }: Help) {
  return (
    <div className="mt-2 space-y-2 rounded-lg bg-sky-50 px-3 py-2.5 text-xs leading-relaxed text-neutral-700">
      <div>
        <p className="font-semibold text-navy-900">받는 법</p>
        <ol className="mt-0.5 list-decimal space-y-0.5 pl-4">
          {steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </div>
      <div>
        <p className="font-semibold text-navy-900">어떻게 전달되나요</p>
        <p className="mt-0.5">{delivery}</p>
      </div>
    </div>
  )
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
  help,
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
  help?: Help
}) {
  const [helpOpen, setHelpOpen] = useState(false)
  return (
    <div>
      <span className="flex items-center gap-2 text-sm font-medium text-neutral-800">
        <label htmlFor={id}>{label}</label>
        {help && <HelpButton label={label} open={helpOpen} onToggle={() => setHelpOpen((v) => !v)} />}
        {alreadySet && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">이미 설정됨</span>}
      </span>
      <span className="mt-1 block text-xs text-neutral-500">{hint}</span>
      {help && helpOpen && <HelpBox steps={help.steps} delivery={help.delivery} />}
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

// 모델 고르기. 권장 모델(AGENT_MODELS)만 보여준다. 다른 모델은 키를 저장한 뒤 입력창 오른쪽에서 고른다.
function ModelField({
  models,
  value,
  onChange,
  disabled,
}: {
  models: string[]
  value: string
  onChange: (value: string) => void
  disabled: boolean
}) {
  const [helpOpen, setHelpOpen] = useState(false)
  return (
    <div>
      <span className="flex items-center gap-2 text-sm font-medium text-neutral-800">
        <label htmlFor="model">모델</label>
        <HelpButton label="모델" open={helpOpen} onToggle={() => setHelpOpen((v) => !v)} />
      </span>
      <span className="mt-1 block text-xs text-neutral-500">AI가 생각할 때 쓰는 모델이에요. 모르면 맨 위(권장)를 그대로 두세요.</span>
      {helpOpen && (
        <HelpBox
          steps={[
            '따로 받을 것은 없어요. OpenRouter 키 하나로 OpenRouter의 모델을 모두 쓸 수 있어요.',
            '맨 위(권장) 모델은 BOSUN의 정책·승인 흐름을 시험한 모델이에요. 시연이나 처음 쓸 때는 이걸 쓰세요.',
            '다른 모델은 저장한 뒤 입력창 오른쪽 모델 이름을 눌러 언제든 바꿀 수 있어요(전체 목록·검색).',
          ]}
          delivery="고른 모델 이름은 이 PC의 WEB 설정에 저장되고, 메시지를 보낼 때마다 AI Agent에 같이 넘어가요. 키와 달리 Agent를 다시 시작하지 않아도 바로 적용돼요."
        />
      )}
      <select
        id="model"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-neutral-500 disabled:bg-neutral-50"
      >
        {models.map((m, i) => (
          <option key={m} value={m}>
            {i === 0 ? `${m} (권장)` : m}
          </option>
        ))}
      </select>
    </div>
  )
}

// 이 PC에 Portainer를 띄운 기본 설치(portainer/portainer-compose.yaml)의 주소. 브라우저용 주소(PORTAINER_URL)가 있으면 그걸 쓴다.
const DEFAULT_PORTAINER_URL = 'https://localhost:9443'

export function SetupPage({ status, onDone, onClose }: Props) {
  const [current, setCurrent] = useState(status)
  const [openrouterKey, setOpenrouterKey] = useState('')
  // 주소가 아직 없으면 미리 채워 둔다. 보통 이 PC의 Portainer라 키 두 개와 모델만 고르면 된다.
  const [portainerUrl, setPortainerUrl] = useState(() => (status.portainer.urlSet ? '' : (status.browserUrl ?? DEFAULT_PORTAINER_URL)))
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [savedModel, setSavedModel] = useState('')
  useEffect(() => {
    agent.getSettings?.().then(
      (s) => {
        setModels(s.models)
        setModel(s.model && s.models.includes(s.model) ? s.model : (s.models[0] ?? ''))
        setSavedModel(s.model ?? '')
      },
      () => undefined,
    )
  }, [])
  const [portainerApiKey, setPortainerApiKey] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<{ ready: boolean; note: string; notice?: string } | null>(null)

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
    // 키·주소가 통과했을 때만 모델도 저장한다(모델은 Agent를 다시 시작하지 않아도 된다).
    if (model && model !== savedModel && agent.saveModel) {
      await agent.saveModel(model).then(
        () => setSavedModel(model),
        () => undefined,
      )
    }
    const left = missingValues(outcome.status)
    // 넣은 값이 저장되긴 했지만 아직 빈 값이 남았으면 여기서 더 받는다.
    if (left.length > 0) {
      setFields({ form: `저장했어요. 아직 없는 값: ${left.join(', ')}` })
      setOpenrouterKey('')
      setPortainerApiKey('')
      return
    }
    setSaved({ ready: outcome.ready, note: noteFor(outcome.checks), ...(outcome.notice ? { notice: outcome.notice } : {}) })
    setOpenrouterKey('')
    setPortainerApiKey('')
  }

  if (saved) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-lg rounded-lg border border-neutral-200 p-6 text-sm">
          <h1 className="text-base font-semibold text-neutral-900">{onClose ? '연결 설정' : '처음 설정'}을 저장했어요</h1>
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

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-lg border border-neutral-200 p-6">
        <div className="mb-4 flex items-center gap-2 text-navy-900">
          <img src="/favicon.png" alt="" width={28} height={28} className="h-7 w-7 rounded-full bg-white ring-1 ring-neutral-300" draggable={false} />
          <span className="font-display text-[22px] leading-none tracking-[0.04em]">BOSUN</span>
        </div>
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-base font-semibold text-neutral-900">{onClose ? '연결 설정' : '처음 설정'}</h1>
          {onClose && (
            <button type="button" onClick={onClose} className="shrink-0 text-sm text-neutral-500 hover:text-neutral-800">
              돌아가기
            </button>
          )}
        </div>
        <p className="mt-2 text-sm text-neutral-600">
          키 두 개와 모델만 정하면 바로 쓸 수 있어요. 키는 직접 발급받아 넣어 주세요. 받는 법은 칸 옆 물음표(?)를 누르면 나와요.
        </p>
        {missing.length > 0 && (
          <p className="mt-2 text-xs text-neutral-500">
            아직 없는 값: <span className="font-mono">{missing.join(', ')}</span>
          </p>
        )}
        {current.warnings && current.warnings.length > 0 && (
          <p className="mt-2 text-xs text-amber-700">
            값이 빈 줄로 남아 있어요: <span className="font-mono">{current.warnings.join(', ')}</span> — 이대로면 도구가 빈 값을
            보내 401이 납니다. 저장하면 그 줄은 지워집니다.
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
            help={{
              steps: [
                <>
                  <a href="https://openrouter.ai" target="_blank" rel="noreferrer" className="underline">
                    openrouter.ai
                  </a>
                  에 가입하고 로그인해요.
                </>,
                '오른쪽 위 메뉴 → Keys → Create Key를 눌러요. 이름은 아무거나(예: bosun), 사용 한도(credit limit)를 정해 두면 안전해요.',
                'sk-or-v1-로 시작하는 키가 한 번만 보여요. 바로 복사해서 여기에 붙여 넣어요.',
                '유료 모델은 OpenRouter에 크레딧을 충전해야 해요. 이름에 :free가 붙은 무료 모델은 충전 없이도 돼요(사용량 제한 있음).',
              ],
              delivery:
                '저장하기 전에 WEB이 OpenRouter에 이 키가 맞는지 먼저 물어봐요. 맞으면 이 PC의 Agent 설정 파일(agent.env)에만 저장하고, AI Agent가 모델을 부를 때만 OpenRouter로 보내요. 화면에 다시 보여주지 않고 저장소(git)에도 올라가지 않아요.',
            }}
          />
          <Field
            id="portainerUrl"
            label="Portainer 주소"
            hint="Portainer 화면이 열리는 주소예요. 이 PC에 띄웠다면 그대로 두세요."
            placeholder={current.portainer.url ?? current.portainerUrlHint}
            value={portainerUrl}
            onChange={setPortainerUrl}
            error={fields.portainerUrl}
            alreadySet={current.portainer.urlSet}
            disabled={busy || !current.writable}
            help={{
              steps: [
                '이 PC에 Portainer를 띄웠다면 미리 채워 둔 https://localhost:9443 그대로 두면 돼요.',
                '브라우저에서 Portainer 화면이 열리는 주소예요. 다른 PC의 Portainer면 그 PC의 주소(예: https://192.168.0.10:9443)를 넣어요.',
                'Portainer가 직접 만든 인증서라 브라우저가 "주의 요함"을 띄워도 정상이에요.',
                'BOSUN을 컨테이너로 설치했다면(docker compose) localhost 대신 Portainer가 있는 PC의 IP 주소를 넣어요. 컨테이너 안에서 localhost는 자기 자신이에요.',
              ],
              delivery:
                '저장하기 전에 이 주소로 Portainer가 응답하는지 확인해요. agent.env의 PORTAINER_URL로 저장되고, AI Agent의 Portainer 도구와 정책 검사가 이 주소로 요청을 보내요.',
            }}
          />
          <Field
            id="portainerApiKey"
            label="Portainer API 키"
            hint="Portainer → My account → Access tokens에서 만든 키(ptr_…)."
            placeholder="ptr_…"
            value={portainerApiKey}
            onChange={setPortainerApiKey}
            error={fields.portainerApiKey}
            alreadySet={current.portainer.keySet}
            secret
            disabled={busy || !current.writable}
            help={{
              steps: [
                'Portainer 화면에 로그인해요(처음이면 관리자 계정을 먼저 만들어요).',
                '오른쪽 위 사용자 이름 → My account로 가요.',
                'Access tokens에서 Add access token을 누르고, 이름(예: bosun)과 지금 비밀번호를 넣어요.',
                'ptr_로 시작하는 키가 한 번만 보여요. 바로 복사해서 여기에 붙여 넣어요.',
              ],
              delivery:
                '저장하기 전에 이 키로 Portainer의 환경 목록을 불러와 확인해요. agent.env의 PORTAINER_API_KEY로 저장되고, AI Agent가 Docker를 다룰 때마다 Portainer에 이 키를 붙여 보내요. 이 키는 만든 계정의 권한을 그대로 가져서, 위험한 작업은 BOSUN 정책 검사와 승인 카드가 한 번 더 막아요.',
            }}
          />
          {models.length > 0 && <ModelField models={models} value={model} onChange={setModel} disabled={busy || !current.writable} />}
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
          className="mt-5 w-full rounded-md bg-navy-800 px-4 py-2 text-sm font-medium text-white hover:bg-navy-700 disabled:bg-neutral-400"
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
