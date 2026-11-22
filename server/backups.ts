// 삭제 전 백업 목록(설정의 백업 화면). 백업은 Agent의 백업 훅(Agent 담당 tool_input_transform_direct_backup_guard.py)이
// 삭제 직전에 inspect 결과를 SQLite에 저장한 것이다. WEB은 그 파일을 읽기만 한다.
// - 위치: BACKUP_DB, 없으면 AGENT_ENV_FILE과 같은 폴더의 backups.sqlite3(훅 기본값과 같다). 같은 호스트(또는 공유 볼륨)여야 한다.
// - 표: backups(ts, time, session_id, environment_id, method, path, query_json, kind, target, inspect_json)
// - inspect에는 환경변수 값 같은 비밀이 들어 있다. 원본은 보내지 않고 허용 목록으로 고른 값만 보낸다.

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { BackupRecord, VolumeBackupRecord } from '../src/lib/agentProtocol.ts'
import { config } from './config.ts'
import { maskText } from './mask.ts'
import { approvalCardsBetween, decisionsBetween } from './store.ts'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function containerSummary(i: Obj): Record<string, string> {
  const cfg = obj(i.Config)
  const host = obj(i.HostConfig)
  const out: Record<string, string> = {}
  const name = str(i.Name)?.replace(/^\//, '')
  if (name) out.이름 = name
  if (str(cfg.Image)) out.이미지 = cfg.Image as string
  const command = [...strs(cfg.Entrypoint), ...strs(cfg.Cmd)].join(' ')
  if (command) out.명령 = maskText(command.slice(0, 500))
  const ports = Object.entries(obj(host.PortBindings)).flatMap(([port, bindings]) =>
    (Array.isArray(bindings) ? bindings : []).map((b) => `${str(obj(b).HostPort) ?? '?'} → ${port}`),
  )
  if (ports.length) out.포트 = ports.join(', ')
  const mounts = (Array.isArray(i.Mounts) ? i.Mounts : []).map((m) => {
    const mount = obj(m)
    return `${str(mount.Name) ?? str(mount.Source) ?? '?'} → ${str(mount.Destination) ?? '?'}${str(mount.Type) ? ` (${mount.Type})` : ''}`
  })
  if (mounts.length) out.마운트 = maskText(mounts.join(', '))
  const env = strs(cfg.Env).map((e) => e.split('=')[0])
  if (env.length) out.환경변수 = `${env.join(', ')} (값은 숨김)`
  const restart = str(obj(host.RestartPolicy).Name)
  if (restart) out['재시작 정책'] = restart
  const networks = Object.keys(obj(obj(i.NetworkSettings).Networks))
  if (networks.length) out.네트워크 = networks.join(', ')
  const state = str(obj(i.State).Status)
  if (state) out['백업 때 상태'] = state
  return out
}

function imageSummary(i: Obj): Record<string, string> {
  const out: Record<string, string> = {}
  const tags = strs(i.RepoTags)
  if (tags.length) out.태그 = tags.join(', ')
  if (str(i.Id)) out.ID = (i.Id as string).replace(/^sha256:/, '').slice(0, 12)
  if (typeof i.Size === 'number') out.크기 = `${Math.round(i.Size / 1_000_000)}MB`
  if (str(i.Created)) out.생성 = i.Created as string
  return out
}

function networkSummary(i: Obj): Record<string, string> {
  const out: Record<string, string> = {}
  if (str(i.Name)) out.이름 = i.Name as string
  if (str(i.Driver)) out.드라이버 = i.Driver as string
  const subnets = (Array.isArray(obj(i.IPAM).Config) ? (obj(i.IPAM).Config as unknown[]) : []).flatMap((c) => str(obj(c).Subnet) ?? [])
  if (subnets.length) out.서브넷 = subnets.join(', ')
  out['연결된 컨테이너'] = `${Object.keys(obj(i.Containers)).length}개`
  return out
}

function summarize(kind: string, inspectJson: string): Record<string, string> {
  let inspect: Obj
  try {
    inspect = obj(JSON.parse(inspectJson))
  } catch {
    return {}
  }
  if (kind === 'container') return containerSummary(inspect)
  if (kind === 'image') return imageSummary(inspect)
  if (kind === 'network') return networkSummary(inspect)
  return {}
}

export function backupDbPath(): string {
  return config.backupDb
}

// 백업 훅은 승인을 묻기 직전(tool_input_transform)에 돌아서, 사용자가 거부한 삭제도 백업이 남는다(2026-10-28 실측).
// 같은 대화에서 백업 직후에 뜬 삭제 카드를 찾아 그 결정으로 실제 삭제 여부를 정한다.
// 대화를 지우면 카드도 지워지므로, 그때는 승인 기록(결정 때 남긴 요약·대상)에서 백업 뒤 첫 삭제 결정을 찾는다.
// 결정은 카드가 뜬 뒤 승인 시간(APPROVAL_TIMEOUT_MS)까지 걸릴 수 있다.
const MATCH_WINDOW_MS = 60_000
const DECISION_WINDOW_MS = MATCH_WINDOW_MS + config.approvalTimeoutMs + 30_000

// 기록 종류마다 짝이 되는 삭제 카드의 요약 앞말(server/tools.ts의 titled). 이름이 같은 다른 종류 카드와 짝짓지 않는다(11/22).
const SUMMARY_PREFIX: Record<string, string> = { container: '컨테이너 ', stack: '스택 ', image: '이미지 ', network: '네트워크 ' }

function outcomeOf(sessionId: string, kind: string, atMs: number, target: string): BackupRecord['outcome'] {
  if (!sessionId || !target) return 'unknown'
  // 훅은 경로의 값(이름 또는 64자리 ID)을 저장하고, 카드는 ID를 앞 12자리로 줄이거나 "이름 (ID)"로 보여준다(server/tools.ts).
  const key = (/^[0-9a-f]{64}$/i.test(target) ? target.slice(0, 12) : target).toLowerCase()
  // 스택 카드는 "이름 (스택 ID 24)"로 보여준다. 스택 기록(11/19, 스택 삭제 전 Compose 저장)은 이름을 저장한다(11/22).
  const keysOf = (cardTarget: string) => {
    const m = /^(.*) \(([0-9a-f]{12})\)$/i.exec(cardTarget) ?? /^(.*) \(스택 ID (\d+)\)$/.exec(cardTarget)
    return (m ? [m[1], m[2]] : [cardTarget]).map((k) => k.trim().toLowerCase())
  }
  const prefix = SUMMARY_PREFIX[kind] ?? ''
  const isDelete = (summary: string | undefined) => Boolean(summary?.startsWith(prefix) && summary.endsWith(' 삭제'))
  const cards = approvalCardsBetween(sessionId, new Date(atMs - 5_000).toISOString(), new Date(atMs + MATCH_WINDOW_MS).toISOString())
  const match = cards.find(
    ({ card }) => card.kind === 'approval' && isDelete(card.summary) && keysOf(card.action.target ?? '').includes(key),
  )
  if (match) return match.status === 'approved' ? 'deleted' : match.status === 'pending' ? 'pending' : 'kept'
  const decided = decisionsBetween(sessionId, new Date(atMs - 5_000).toISOString(), new Date(atMs + DECISION_WINDOW_MS).toISOString()).find(
    (d) => isDelete(d.summary) && keysOf(d.target ?? '').includes(key),
  )
  if (!decided) return 'unknown'
  return decided.decision === 'approved' ? 'deleted' : 'kept'
}

// 파일이 없거나 표가 없으면 빈 목록이다(아직 삭제한 적이 없음).
export function listBackups(limit: number): { available: boolean; records: BackupRecord[] } {
  const path = backupDbPath()
  if (!path || !existsSync(path)) return { available: Boolean(path), records: [] }
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'backups'").get()
    if (!hasTable) return { available: true, records: [] }
    const rows = db
      .prepare('SELECT rowid, ts, session_id, environment_id, kind, target, inspect_json FROM backups ORDER BY ts DESC LIMIT ?')
      .all(limit)
    return {
      available: true,
      records: rows.map((r) => ({
        id: Number(r.rowid),
        at: new Date(Number(r.ts) * 1000).toISOString(),
        sessionId: String(r.session_id ?? ''),
        environmentId: String(r.environment_id ?? ''),
        kind: String(r.kind ?? ''),
        target: maskText(String(r.target ?? '')),
        summary: summarize(String(r.kind ?? ''), String(r.inspect_json ?? '')),
        outcome: outcomeOf(String(r.session_id ?? ''), String(r.kind ?? ''), Number(r.ts) * 1000, String(r.target ?? '')),
      })),
    }
  } finally {
    db.close()
  }
}

// ---- soteria "지금 백업"(볼륨 데이터) ----
// 백업 기록 훅(tool_response_transform_soteria_record.py)이 성공한 백업만 한 줄씩 남긴다:
// {"app": <볼륨>, "job_id", "sha256", "size", "name": <파일 이름>, "finished_at", "recorded_at": <초>}
// 11-19 실측: 설정 > 백업이 이 기록을 읽지 않아 "지금 백업"을 해도 "아직 백업이 없어요"였다.
// 백업 파일 자체는 soteria 보관 볼륨에 있어 WEB은 볼 수 없다(7일 지나면 지워져도 기록 줄은 남는다).

const MAX_RECORD_BYTES = 2_000_000

function readTail(path: string): string {
  const size = statSync(path).size
  const start = Math.max(0, size - MAX_RECORD_BYTES)
  const buf = Buffer.alloc(size - start)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, buf.length, start)
  } finally {
    closeSync(fd)
  }
  const text = buf.toString('utf8')
  // 잘라 읽었으면 첫 줄은 중간부터라 버린다.
  return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
}

export function listVolumeBackups(limit: number): { available: boolean; records: VolumeBackupRecord[] } {
  const path = config.soteriaRecord
  if (!path) return { available: false, records: [] }
  if (!existsSync(path)) return { available: true, records: [] }
  const records: VolumeBackupRecord[] = []
  for (const line of readTail(path).split('\n')) {
    if (!line.trim()) continue
    let r: Obj
    try {
      r = obj(JSON.parse(line))
    } catch {
      continue
    }
    const volume = str(r.app)
    const sha256 = str(r.sha256)
    const recordedAt = typeof r.recorded_at === 'number' ? r.recorded_at : undefined
    if (!volume || !sha256 || recordedAt === undefined) continue
    records.push({
      volume,
      jobId: str(r.job_id) ?? '',
      file: str(r.name) ?? '',
      sha256,
      size: typeof r.size === 'number' ? r.size : undefined,
      at: new Date(recordedAt * 1000).toISOString(),
    })
  }
  return { available: true, records: records.reverse().slice(0, limit) }
}
