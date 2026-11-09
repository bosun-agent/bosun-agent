import { useEffect, useState } from 'react'
import type { RiskLevel } from '../lib/agentProtocol'
import type { ApprovalRequest } from '../types'

interface ApprovalCardProps {
  approval: ApprovalRequest
  expired: boolean
  onApprove: () => void
  onDeny: () => void
  onExpire: () => void
}

// 남은 시간이 이보다 적으면 강조한다.
const URGENT_MS = 60_000

// 호스트까지 영향이 가는 사유와 설명할 수 없는 도구는 빨간색으로 보여준다.
const DANGER_CODES = new Set(['HOST_TAKEOVER', 'PRIVILEGED', 'HOST_NAMESPACE', 'UNKNOWN'])
// 다른 대화가 같은 대상을 기다리는 경우처럼 결정 전에 꼭 봐야 하는 안내
const WARN_CODES = new Set(['CONCURRENT', 'ORPHANS'])

// 카드 맨 위 위험도 표시. 문장을 읽기 전에 재시작(곧 돌아옴)과 삭제(되돌릴 수 없음)를 구분하게 한다.
const RISK_STYLE: Record<RiskLevel['level'], string> = {
  high: 'bg-red-50 text-red-700',
  medium: 'bg-amber-50 text-amber-800',
  low: 'bg-navy-50 text-navy-700',
  unknown: 'border border-red-300 bg-white text-red-700',
}

function RiskBadge({ risk }: { risk: RiskLevel }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${RISK_STYLE[risk.level]}`}>{risk.label}</span>
}

// 카드 한 장에는 위험도에 맞는 색 하나만 쓴다.
const TONE = {
  danger: { border: 'border-red-200', head: 'text-red-700', dot: 'bg-red-500', approve: 'bg-red-600 hover:bg-red-700' },
  warn: { border: 'border-amber-300', head: 'text-amber-800', dot: 'bg-amber-500', approve: 'bg-navy-800 hover:bg-navy-700' },
  calm: { border: 'border-navy-100', head: 'text-navy-700', dot: 'bg-navy-600', approve: 'bg-navy-800 hover:bg-navy-700' },
}
function toneOf(risk?: RiskLevel) {
  if (risk?.level === 'high' || risk?.level === 'unknown') return TONE.danger
  if (risk?.level === 'medium') return TONE.warn
  return TONE.calm
}
// 위험 사유가 아니라 "승인하면 어떻게 되는지" 설명이다(server/tools.ts EFFECT). 점 대신 → 로 보여준다.
const EFFECT_CODE = 'EFFECT'

export function ApprovalCard({
  approval,
  expired,
  onApprove,
  onDeny,
  onExpire,
}: ApprovalCardProps) {
  const { summary, action, reasons, risk, expiresAt } = approval
  const remainingMs = useRemainingMs(expiresAt, expired)

  useEffect(() => {
    if (!expired && remainingMs <= 0) onExpire()
  }, [expired, remainingMs, onExpire])

  if (expired) {
    return (
      <div className="max-w-[85%] rounded-2xl border border-neutral-300 bg-neutral-50 px-4 py-3 text-[15px]">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-neutral-500">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-neutral-400" />
          승인 시간이 지났어요
        </div>
        <p className="text-neutral-500 line-through">
          {summary}
        </p>
        <p className="mt-2 font-mono text-xs text-neutral-500">
          {action.tool}
          {action.target && ` → ${action.target}`}
        </p>
        <p className="mt-2 text-sm text-neutral-600">
          실행되지 않았어요. 필요하면 다시 요청해주세요.
        </p>
      </div>
    )
  }

  const urgent = remainingMs <= URGENT_MS
  const tone = toneOf(risk)
  const shownParams = { 도구: `${action.tool}${action.target ? ` → ${action.target}` : ''}`, ...action.params }

  return (
    <div className={`w-full max-w-[560px] rounded-2xl border bg-white px-4 py-3.5 text-[15px] shadow-[0_1px_3px_rgb(28_27_24/0.06)] ${tone.border}`}>
      <div className="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium">
        <span className={`flex items-center gap-1.5 ${tone.head}`}>
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${tone.dot}`} />
          승인이 필요해요
          {risk && <RiskBadge risk={risk} />}
        </span>
        <span
          className={`tabular-nums ${
            urgent
              ? 'text-red-600'
              : 'text-neutral-500'
          }`}
        >
          {formatRemaining(remainingMs)} 남음
        </span>
      </div>
      <p className="text-[17px] font-semibold tracking-[-0.012em] text-neutral-900">{summary}</p>
      {reasons.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm leading-relaxed">
          {reasons.map((reason) => (
            <li
              key={reason.code}
              className={
                DANGER_CODES.has(reason.code)
                  ? 'font-medium text-red-700'
                  : WARN_CODES.has(reason.code)
                    ? 'font-medium text-amber-800'
                    : reason.code === EFFECT_CODE
                      ? 'text-neutral-800'
                      : 'text-neutral-600'
              }
            >
              {reason.code === EFFECT_CODE ? '' : WARN_CODES.has(reason.code) ? '⚠ ' : '· '}
              {reason.message}
            </li>
          ))}
        </ul>
      )}
      <ParamList params={shownParams} />
      <div className="mt-3.5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onDeny}
          className="rounded-lg border border-neutral-300 px-4 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100"
        >
          거부
        </button>
        <button
          type="button"
          onClick={onApprove}
          className={`rounded-lg px-4 py-1.5 text-sm font-semibold text-white transition-colors ${tone.approve}`}
        >
          승인
        </button>
      </div>
    </div>
  )
}

// 요청 원문(Docker Engine API). 처음 보는 사람에게는 어려워서 "기술 정보"로 접어 둔다.
const TECH_KEYS = new Set(['도구', '요청', '옵션', '본문', 'compose 파일'])

// Docker Engine API 쿼리 옵션 → 뜻. 표에 없는 옵션은 원문만 보여준다.
const OPTION_HELP: Record<string, string> = {
  force: '강제로 실행(실행 중이거나 쓰는 중이어도)',
  v: '딸린 익명 볼륨도 같이 삭제',
  t: '멈추기 전에 기다릴 시간(초)',
  signal: '프로그램에 보낼 종료 신호',
  name: '이름',
  fromImage: '받을 이미지',
  tag: '태그(버전)',
  noprune: '태그 없는 상위 이미지는 남김',
  link: '링크만 삭제',
  tail: '로그 끝에서 몇 줄',
  follow: '로그를 계속 받기',
  all: '멈춘 것도 포함',
}

function OptionList({ value }: { value: string }) {
  const pairs = value.split(', ').map((p) => {
    const i = p.indexOf('=')
    return i < 0 ? { key: p, val: '' } : { key: p.slice(0, i), val: p.slice(i + 1) }
  })
  return (
    <ul className="space-y-0.5">
      {pairs.map(({ key, val }) => (
        <li key={key}>
          <span className="font-mono">
            {key}={val}
          </span>
          {OPTION_HELP[key] && <span className="ml-1.5 font-sans text-neutral-500">{OPTION_HELP[key]}</span>}
        </li>
      ))}
    </ul>
  )
}

// 이름 칸은 가장 긴 이름에 맞춘다(dl이 두 칸 grid). "빠지는 서비스"처럼 긴 이름도 한 줄로 둔다.
function ParamRow({ name, value }: { name: string; value: unknown }) {
  return (
    <>
      <dt className="whitespace-nowrap text-neutral-500">{name}</dt>
      <dd className="max-h-32 min-w-0 overflow-y-auto font-mono break-all whitespace-pre-wrap text-neutral-800">
        {name === '옵션' ? <OptionList value={String(value)} /> : String(value)}
      </dd>
    </>
  )
}

const PARAM_GRID = 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1'

// 서버가 고른 요청 값(이미지, 명령, 마운트 등). 명령은 길 수 있어서 높이를 제한하고 스크롤한다.
// 옵션은 동작을 바꾸므로(force 등) 접지 않고 위에 보여준다. 요청 원문과 본문만 접는다.
function ParamList({ params }: { params: Record<string, unknown> }) {
  const entries = Object.entries(params)
  const main = entries.filter(([k]) => !TECH_KEYS.has(k) || k === '옵션')
  const tech = entries.filter(([k]) => TECH_KEYS.has(k) && k !== '옵션')
  return (
    <div className="mt-2.5 rounded-lg bg-neutral-50 px-3 py-2 text-xs">
      {main.length > 0 && (
        <dl className={PARAM_GRID}>
          {main.map(([name, value]) => (
            <ParamRow key={name} name={name} value={value} />
          ))}
        </dl>
      )}
      {tech.length > 0 && (
        <details className={main.length > 0 ? 'mt-1.5' : ''}>
          <summary className="cursor-pointer text-neutral-500">
            {tech.some(([k]) => k === 'compose 파일') ? '기술 정보 · compose 파일 보기' : '기술 정보 (Docker에 보낼 요청)'}
          </summary>
          <dl className={`mt-1 ${PARAM_GRID}`}>
            {tech.map(([name, value]) => (
              <ParamRow key={name} name={name} value={value} />
            ))}
          </dl>
        </details>
      )}
    </div>
  )
}

// expiresAt까지 남은 시간을 1초마다 다시 계산한다. 만료된 카드는 타이머를 돌리지 않는다.
function useRemainingMs(expiresAt: string, stopped: boolean) {
  const deadline = Date.parse(expiresAt)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (stopped) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [stopped])

  return Math.max(0, deadline - now)
}

function formatRemaining(ms: number) {
  const totalSeconds = Math.ceil(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
