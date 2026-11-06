// 삭제 전 백업 목록(설정의 백업 화면). 백업은 Agent의 백업 훅(Agent 담당 tool_input_transform_direct_backup_guard.py)이
// 삭제 직전에 inspect 결과를 SQLite에 저장한 것이다. WEB은 그 파일을 읽기만 한다.
// - 위치: BACKUP_DB, 없으면 AGENT_ENV_FILE과 같은 폴더의 backups.sqlite3(훅 기본값과 같다). 같은 호스트(또는 공유 볼륨)여야 한다.
// - 표: backups(ts, time, session_id, environment_id, method, path, query_json, kind, target, inspect_json)
// - inspect에는 환경변수 값 같은 비밀이 들어 있다. 원본은 보내지 않고 허용 목록으로 고른 값만 보낸다.

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { BackupRecord } from '../src/lib/agentProtocol.ts'
import { config } from './config.ts'
import { maskText } from './mask.ts'
import { approvalCardsBetween } from './store.ts'

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
const MATCH_WINDOW_MS = 60_000

function outcomeOf(sessionId: string, atMs: number, target: string): BackupRecord['outcome'] {
  if (!sessionId || !target) return 'unknown'
  // 훅은 경로의 값(이름 또는 64자리 ID)을 저장하고, 카드는 ID를 앞 12자리로 줄이거나 "이름 (ID)"로 보여준다(server/tools.ts).
  const key = (/^[0-9a-f]{64}$/i.test(target) ? target.slice(0, 12) : target).toLowerCase()
  const keysOf = (cardTarget: string) => {
    const m = /^(.*) \(([0-9a-f]{12})\)$/i.exec(cardTarget)
    return (m ? [m[1], m[2]] : [cardTarget]).map((k) => k.trim().toLowerCase())
  }
  const cards = approvalCardsBetween(sessionId, new Date(atMs - 5_000).toISOString(), new Date(atMs + MATCH_WINDOW_MS).toISOString())
  const match = cards.find(
    ({ card }) => card.kind === 'approval' && card.summary.endsWith(' 삭제') && keysOf(card.action.target ?? '').includes(key),
  )
  if (!match) return 'unknown'
  if (match.status === 'approved') return 'deleted'
  if (match.status === 'pending') return 'pending'
  return 'kept'
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
        outcome: outcomeOf(String(r.session_id ?? ''), Number(r.ts) * 1000, String(r.target ?? '')),
      })),
    }
  } finally {
    db.close()
  }
}
