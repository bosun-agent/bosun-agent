import { useEffect, useState, type ReactNode } from 'react'
import type { AgentConfigSummary, AuditRecord, BackupRecord, SessionUsage, SystemInfo, UsageTotals } from '../lib/agentProtocol'
import { agent } from '../lib/agent'
import { notifyEnabled, setNotifyEnabled } from '../lib/notify'

// 설정 창의 정책·승인 기록·정보·알림 화면.
// 정책은 Agent 설정(agent.yaml)에서 고른 값을 읽어서 보여준다. 웹에서 바꾸는 기능은 팀 결정이 필요하다(계약 7장).

function useLoad<T>(load: (() => Promise<T>) | undefined) {
  const [data, setData] = useState<T | null>(null)
  const [failed, setFailed] = useState(!load)
  useEffect(() => {
    load?.().then(setData, () => setFailed(true))
    // 화면을 열 때 한 번만 부른다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return { data, failed }
}

function Note({ children }: { children: ReactNode }) {
  return <p className="px-1 text-xs text-neutral-500">{children}</p>
}

function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-md bg-white px-3 py-2">
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      {children}
    </div>
  )
}

function Unavailable({ failed }: { failed: boolean }) {
  if (!failed) return <p className="px-1 text-sm text-neutral-500">불러오는 중…</p>
  if (!agent.getSystem) return <p className="px-1 text-sm text-neutral-500">목업 모드에서는 볼 수 없어요. WEB 백엔드에 붙여서 열어주세요.</p>
  return <p className="px-1 text-sm text-red-600">불러오지 못했어요. AI Agent가 켜져 있는지 확인해주세요.</p>
}

// ---- 정책 ----

const SAFETY: Record<string, string> = {
  strict: '모든 도구 호출을 물어봐요. 아래 "자동 허용"에 맞는 것만 묻지 않고 실행해요.',
  balanced: '읽기 전용은 바로 실행하고, 위험하거나 모르는 호출은 물어봐요.',
  restricted: '읽기 전용만 실행하고 나머지는 묻지 않고 거부해요. 승인 카드가 뜨지 않아요.',
  autonomous: '아무것도 묻지 않고 실행해요. BOSUN에서는 쓰지 않아요.',
}

// permissions 패턴 → 사람이 읽는 설명. 표에 없는 패턴은 원문만 보여준다.
const RULES: [RegExp, string][] = [
  [/^docker_proxy:method=GET$/, '조회(GET 요청)'],
  [/^EndpointList$/, '환경 목록 조회'],
  [/exec/, '컨테이너 안 명령 실행(exec)'],
  [/archive/, '컨테이너 안 파일 읽기·쓰기'],
  [/\/export/, '컨테이너 파일시스템 내보내기'],
  [/prune/, '일괄 정리(prune)'],
  [/method=DELETE:path=\*\/volumes/, '볼륨 삭제'],
  [/path=\*%\*/, '인코딩된 경로(%XX)로 규칙을 피하는 요청'],
  [/images\/get|images\/\*\/get/, '이미지 내보내기(tar)'],
]

function ruleLabel(pattern: string): string | undefined {
  return RULES.find(([re]) => re.test(pattern))?.[1]
}

const HOOKS: Record<string, string> = {
  tool_input_transform: '도구를 실행하기 전에 요청을 검사해요(허용 목록 정책, 삭제 전 백업).',
  tool_guard: '도구를 실행하기 전에 막을지 정해요.',
  pre_tool_use: '승인을 묻기 직전에 검사해요.',
  permission_request: '승인을 묻기 전에 자동으로 허용·거부할 수 있어요.',
  post_tool_use: '도구를 실행한 뒤에 결과를 검사해요.',
  tool_response_transform: '도구 결과에 섞인 수상한 지시(인젝션)를 표시해요.',
  user_prompt_submit: '사용자 메시지를 모델에 보내기 전에 검사해요(인젝션 방어).',
  user_steering_messages_submit: '처리 중에 끼어든 메시지를 검사해요.',
  user_followup_submit: '이어서 보낸 메시지를 검사해요.',
  before_llm_call: '모델을 부르기 직전에 대화를 정리해요(막힌 메시지 가리기).',
  session_start: '대화를 시작할 때 실행돼요.',
}

function RuleList({ title, tone, rules, empty }: { title: string; tone: string; rules: string[]; empty: string }) {
  return (
    <Box title={title}>
      {rules.length === 0 ? (
        <p className="text-xs text-neutral-500">{empty}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rules.map((r) => (
            <li key={r} className="flex flex-wrap items-baseline gap-x-2">
              <span className={tone}>{ruleLabel(r) ?? '규칙'}</span>
              <code className="text-[11px] break-all text-neutral-500">{r}</code>
            </li>
          ))}
        </ul>
      )}
    </Box>
  )
}

export function PolicySection() {
  const { data, failed } = useLoad<SystemInfo>(agent.getSystem)
  if (!data) return <Unavailable failed={failed} />
  const cfg = data.config
  if (!cfg) return <p className="px-1 text-sm text-red-600">AI Agent 설정을 읽지 못했어요. Agent가 켜져 있는지 확인해주세요.</p>
  return <PolicyView cfg={cfg} approvalTimeoutSec={data.web.approvalTimeoutSec} />
}

function PolicyView({ cfg, approvalTimeoutSec }: { cfg: AgentConfigSummary; approvalTimeoutSec: number }) {
  return (
    <div className="space-y-2">
      <Note>
        AI Agent 설정(agent.yaml)에 적힌 정책이에요. 실제로 막고 허용하는 건 Agent 정책이고, WEB은 그 결과를 승인 카드와 차단 안내로
        보여줘요. 정책은 지금 Agent 설정 파일에서만 바꿀 수 있어요.
      </Note>
      {cfg.agents.map((a) => (
        <Box key={a.name} title={`안전 모드: ${a.safety ?? '지정 안 함'}`}>
          <p className="text-sm text-neutral-700">
            {a.safety ? (SAFETY[a.safety] ?? '알 수 없는 모드예요.') : '읽기 전용은 바로 실행하고 나머지는 물어봐요.'}
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            승인 카드는 {Math.round(approvalTimeoutSec / 60)}분 안에 결정하지 않으면 자동으로 거부돼요(WEB 설정).
            {a.maxIterations !== undefined && ` 한 번에 도구를 ${a.maxIterations}번까지 불러요.`}
          </p>
        </Box>
      ))}
      <RuleList title="자동 허용 (승인 없이 실행)" tone="text-neutral-800" rules={cfg.permissions.allow} empty="없어요." />
      <RuleList title="항상 묻기" tone="text-amber-700" rules={cfg.permissions.ask} empty="따로 정한 것은 없어요. 자동 허용에 없는 호출은 안전 모드에 따라 물어요." />
      <RuleList title="항상 거부 (승인해도 안 됨)" tone="text-red-700" rules={cfg.permissions.deny} empty="없어요." />
      {cfg.agents.map((a) =>
        a.hooks.length === 0 ? null : (
          <Box key={`${a.name}-hooks`} title="정책 훅 (Agent가 실행하는 검사 프로그램)">
            <ul className="space-y-1.5 text-sm">
              {a.hooks.map((h) => (
                <li key={h.event}>
                  <p className="text-neutral-800">{HOOKS[h.event] ?? h.event}</p>
                  <p className="text-[11px] text-neutral-500">
                    <code>{h.event}</code>
                    {h.matchers.length > 0 && ` · 대상 ${h.matchers.join(', ')}`} · {h.scripts.join(', ')}
                  </p>
                </li>
              ))}
            </ul>
          </Box>
        ),
      )}
    </div>
  )
}

// ---- 승인 기록 ----

const DECISION: Record<string, { label: string; tone: string }> = {
  approved: { label: '승인', tone: 'text-neutral-900' },
  denied: { label: '거부', tone: 'text-neutral-600' },
  expired: { label: '만료', tone: 'text-neutral-500' },
  cancelled: { label: '취소', tone: 'text-neutral-500' },
  pending: { label: '대기', tone: 'text-amber-700' },
}

export function AuditSection() {
  const { data, failed } = useLoad<AuditRecord[]>(agent.getAudit && (() => agent.getAudit!(200)))
  if (!data) return <Unavailable failed={failed} />
  if (data.length === 0) return <Note>아직 승인 기록이 없어요.</Note>
  return (
    <div className="space-y-1">
      <Note>최근 200건이에요. 누가, 언제, 무엇을 승인·거부했는지 남아요. 대화를 지워도 기록은 남아요.</Note>
      <ul className="divide-y divide-neutral-200 rounded-md bg-white">
        {data.map((r) => {
          const d = DECISION[r.decision] ?? { label: r.decision, tone: '' }
          return (
            <li key={`${r.approvalId}-${r.at}`} className="flex gap-3 px-3 py-2 text-sm">
              <span className={`w-10 shrink-0 font-medium ${d.tone}`}>{d.label}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{r.summary ?? '(지운 대화의 카드)'}</span>
                <span className="block text-[11px] text-neutral-500">
                  {new Date(r.at).toLocaleString()} · {r.user === 'system' ? '자동(만료)' : '사용자'} · <code>{r.tool}</code>
                  {r.target && ` · ${r.target}`}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ---- 정보 ----

function usageText(u: SessionUsage): string {
  return `입력 토큰 ${u.inputTokens.toLocaleString()} · 출력 토큰 ${u.outputTokens.toLocaleString()}${u.cost !== undefined ? ` · 약 $${u.cost.toFixed(4)}` : ''}`
}

const COST_NOTE = '비용은 Docker Agent가 모델 가격표로 계산한 값이에요. 실제 청구액은 provider 화면에서 확인해주세요.'

export function InfoSection({ activeServerId }: { activeServerId?: string }) {
  const { data, failed } = useLoad<SystemInfo>(agent.getSystem)
  const { data: usage } = useLoad<SessionUsage>(agent.getUsage && activeServerId ? () => agent.getUsage!(activeServerId) : undefined)
  const { data: totals } = useLoad<UsageTotals>(agent.getUsageTotals)
  const [tools, setTools] = useState<number | 'loading' | 'failed' | null>(null)

  async function countTools() {
    if (!agent.getToolCount) return
    setTools('loading')
    try {
      setTools(await agent.getToolCount())
    } catch {
      setTools('failed')
    }
  }

  if (!data) return <Unavailable failed={failed} />
  const a = data.agent
  return (
    <div className="space-y-2">
      <Box title="연결 상태">
        <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-sm">
          <dt className="text-neutral-500">AI Agent</dt>
          <dd className={a.reachable ? 'text-neutral-900' : 'text-red-600'}>
            {a.reachable ? (a.ready === false ? '연결됨(준비 안 됨)' : '연결됨') : '연결 안 됨'}
            {a.error && <span className="block text-xs text-red-600">{a.error}</span>}
          </dd>
          <dt className="text-neutral-500">Agent 버전</dt>
          {/* 실제 Docker Agent(v1.148.0)는 /health에 빈 버전을 준다(2026-10-28 실측). */}
          {a.version ? (
            <dd className="font-mono text-[13px]">{a.version}</dd>
          ) : (
            <dd className="text-[13px] text-neutral-500">Agent가 알려주지 않음</dd>
          )}
          <dt className="text-neutral-500">Agent 이름</dt>
          <dd className="font-mono text-[13px]">{a.name}</dd>
          <dt className="text-neutral-500">WEB 버전</dt>
          <dd className="font-mono text-[13px]">{data.web.version}</dd>
          <dt className="text-neutral-500">처리 중</dt>
          <dd>
            {data.web.running} / 최대 {data.web.maxTurns}개 대화
          </dd>
        </dl>
      </Box>
      {totals && (
        <Box title="전체 사용량">
          <dl className="grid grid-cols-[5rem_1fr] gap-y-1 text-sm">
            <dt className="text-neutral-500">오늘</dt>
            <dd>{usageText(totals.today)}</dd>
            <dt className="text-neutral-500">이번 달</dt>
            <dd>{usageText(totals.month)}</dd>
            <dt className="text-neutral-500">전체</dt>
            <dd>{usageText(totals.total)}</dd>
          </dl>
          <p className="mt-1 text-xs text-neutral-500">
            WEB 0.5.0부터 대화 한 번마다 기록해요. 대화를 지워도 남아요. 날짜는 서버 시간 기준이에요. {COST_NOTE}
          </p>
        </Box>
      )}
      {usage && (
        <Box title="지금 대화의 사용량">
          <p className="text-sm">{usageText(usage)}</p>
          <p className="text-xs text-neutral-500">{COST_NOTE}</p>
        </Box>
      )}
      {data.config?.agents.map((ag) => (
        <Box key={ag.name} title={`Agent: ${ag.name}`}>
          {ag.description && <p className="text-sm text-neutral-700">{ag.description}</p>}
          <dl className="mt-1 grid grid-cols-[7rem_1fr] gap-y-1 text-sm">
            <dt className="text-neutral-500">기본 모델</dt>
            <dd className="font-mono text-[13px]">
              {ag.model ?? '-'}
              {(() => {
                const m = data.config?.models.find((x) => x.name === ag.model)
                return m ? ` (${[m.provider, m.model].filter(Boolean).join('/')}${m.maxTokens ? `, 최대 ${m.maxTokens.toLocaleString()} 토큰` : ''})` : ''
              })()}
            </dd>
            {ag.toolsets.map((t, i) => (
              <div key={i} className="contents">
                <dt className="text-neutral-500">도구 묶음 {i + 1}</dt>
                <dd className="text-[13px]">
                  <span className="font-mono">
                    {t.type}
                    {t.command && ` · ${t.command}`} {t.args.join(' ')}
                  </span>
                  {t.tools.length > 0 && <span className="block">도구: {t.tools.join(', ')}</span>}
                  {t.callTimeout && <span className="block text-neutral-500">호출 제한 시간 {t.callTimeout}</span>}
                  {t.env.length > 0 && <span className="block text-neutral-500">환경변수: {t.env.join(', ')} (값은 숨김)</span>}
                </dd>
              </div>
            ))}
          </dl>
          {ag.instruction && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-neutral-600">Agent 지시문 보기</summary>
              <pre className="mt-1 max-h-64 overflow-auto rounded bg-neutral-50 p-2 text-[11px] whitespace-pre-wrap">{ag.instruction}</pre>
            </details>
          )}
        </Box>
      ))}
      {agent.getToolCount && (
        <Box title="쓸 수 있는 도구 수">
          <div className="flex items-center gap-2 text-sm">
            <button type="button" onClick={countTools} disabled={tools === 'loading'} className="rounded-md border border-neutral-300 px-2 py-1 text-xs disabled:opacity-40">
              확인하기
            </button>
            {tools === 'loading' && <span className="text-neutral-500">MCP 서버를 띄워서 세는 중…</span>}
            {tools === 'failed' && <span className="text-red-600">확인하지 못했어요. Portainer MCP 연결을 확인해주세요.</span>}
            {typeof tools === 'number' && <span>{tools}개</span>}
          </div>
        </Box>
      )}
    </div>
  )
}

// ---- 알림 ----

export function NotifySection() {
  const [on, setOn] = useState(notifyEnabled)
  const [denied, setDenied] = useState(false)

  async function toggle() {
    const want = !on
    const ok = await setNotifyEnabled(want)
    setDenied(want && !ok)
    setOn(want && ok)
  }

  return (
    <div className="space-y-2">
      <Note>다른 탭이나 창을 보고 있을 때 승인 카드가 뜨면 탭 제목에 "(승인 필요)"가 붙어요. 브라우저 알림도 받을 수 있어요.</Note>
      <label className="flex items-center gap-2 rounded-md bg-white px-3 py-2 text-sm">
        <input type="checkbox" checked={on} onChange={toggle} />
        승인이 필요하면 브라우저 알림 보내기
      </label>
      {denied && <p className="px-1 text-sm text-red-600">브라우저가 알림을 막았어요. 주소창 옆 사이트 설정에서 알림을 허용해주세요.</p>}
      <Note>이 설정은 이 브라우저에만 저장돼요. 브라우저 알림은 HTTPS나 localhost에서만 동작해요.</Note>
    </div>
  )
}

// ---- 백업 ----

const KIND_LABEL: Record<string, string> = { container: '컨테이너', image: '이미지', network: '네트워크' }

// 다시 만들 때 요청에 넣는 값. 모델이 그대로 쓸 수 있는 것만 넣는다. 값이 숨겨진 환경변수나, 대부분 이미지 기본값인 명령까지
// 넣었더니 모델이 생성 설정을 비우거나 잘못 감싸서 보내며 수십 번 헤맸다(2026-10-28 리허설).
const RESTORE_KEYS: Record<string, string[]> = {
  container: ['이미지', '포트', '마운트', '재시작 정책', '네트워크'],
  network: ['드라이버', '서브넷'],
}
// Docker 기본값이라 적지 않아도 같은 값
const RESTORE_DEFAULTS: Record<string, string> = { '재시작 정책': 'no', 네트워크: 'bridge', 드라이버: 'bridge' }

// 백업한 설정으로 다시 만들어 달라는 요청 문장. 보내지는 않고 입력창에 채운다. 실행은 평소처럼 승인을 받는다.
function restorePrompt(r: BackupRecord): string {
  const kind = KIND_LABEL[r.kind] ?? r.kind
  if (r.kind === 'image') return `지운 이미지 ${r.summary.태그 ?? r.target}를 다시 받아줘.`
  const lines = (RESTORE_KEYS[r.kind] ?? [])
    .filter((k) => r.summary[k] && r.summary[k] !== RESTORE_DEFAULTS[k])
    .map((k) => `- ${k}: ${r.summary[k]}`)
  return [`지운 ${kind} ${r.summary.이름 ?? r.target}를 다시 만들어줘.`, ...lines].join('\n')
}

// 백업은 승인 전에 만들어져서 거부한 삭제도 남는다. 같은 대화의 승인 카드와 짝지은 결과를 보여준다(server/backups.ts).
const OUTCOME: Record<BackupRecord['outcome'], { label: string; tone: string }> = {
  deleted: { label: '삭제 승인함', tone: 'bg-neutral-100 text-neutral-700' },
  kept: { label: '지우지 않음(거부·만료)', tone: 'bg-emerald-50 text-emerald-700' },
  pending: { label: '승인 기다리는 중', tone: 'bg-amber-50 text-amber-700' },
  unknown: { label: '삭제 여부 확인 못 함', tone: 'bg-neutral-100 text-neutral-500' },
}

export function BackupSection({ onDraft }: { onDraft?: (text: string) => void }) {
  const { data, failed } = useLoad(agent.getBackups)
  if (!data) return <Unavailable failed={failed} />
  if (!data.available) {
    return <Note>WEB 백엔드에 백업 파일 위치가 없어요. BACKUP_DB(또는 AGENT_ENV_FILE)를 정해주세요. Agent 백업 훅과 같은 호스트여야 해요.</Note>
  }
  return (
    <div className="space-y-1.5">
      <Note>
        컨테이너·이미지·네트워크를 지우기 직전에 Agent 백업 훅이 설정을 저장해요. 설정만 저장하고 볼륨이나 컨테이너 안의 파일은 저장하지
        않아요. 백업은 승인을 묻기 전에 만들어져서, 거부한 삭제도 목록에 남아요. 보관 기간은 훅 설정(BACKUP_TTL_DAYS, 기본 30일)을 따라요.
      </Note>
      {data.records.length === 0 && <Note>아직 백업이 없어요.</Note>}
      <ul className="space-y-1.5">
        {data.records.map((r) => {
          // 0.5.0 전 백엔드는 outcome을 주지 않는다. 화면만 먼저 바뀐 경우에도 깨지지 않게 모름으로 둔다.
          const outcome = OUTCOME[r.outcome] ?? OUTCOME.unknown
          return (
          <li key={r.id} className="rounded-md bg-white px-3 py-2 text-sm">
            <details>
              <summary className="cursor-pointer">
                <span className="font-medium">
                  {KIND_LABEL[r.kind] ?? r.kind} {r.summary.이름 ?? r.summary.태그 ?? r.target}
                </span>
                <span className={`ml-2 rounded-full px-2 py-0.5 text-[11px] ${outcome.tone}`}>{outcome.label}</span>
                <span className="ml-2 text-xs text-neutral-500">{new Date(r.at).toLocaleString()}</span>
              </summary>
              <dl className="mt-1.5 grid grid-cols-[6rem_1fr] gap-y-0.5 text-xs">
                {Object.entries(r.summary).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-neutral-500">{k}</dt>
                    <dd className="font-mono break-all">{v}</dd>
                  </div>
                ))}
              </dl>
              {/* 지우지 않았거나 아직 결정 전이면 다시 만들 대상이 없다. */}
              {onDraft && r.outcome !== 'kept' && r.outcome !== 'pending' && (
                <>
                  <button
                    type="button"
                    onClick={() => onDraft(restorePrompt(r))}
                    className="mt-2 rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50"
                  >
                    이 설정으로 다시 만들어 달라고 쓰기
                  </button>
                  {r.kind === 'container' && (
                    <p className="mt-1 text-[11px] text-neutral-500">
                      이미지·포트 같은 기본 설정만 넣어요. 환경변수 값과 명령은 넣지 않으니, 필요하면 보내기 전에 직접 적어주세요.
                    </p>
                  )}
                </>
              )}
            </details>
          </li>
          )
        })}
      </ul>
    </div>
  )
}
