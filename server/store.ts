// WEB 고유 데이터: 승인·차단 카드와 승인 감사 기록.
// 대화 내용은 Docker Agent session.db가 보관하므로 여기 두지 않는다.
// Node 내장 SQLite(node:sqlite)를 쓴다. Node 22에서는 실험 기능이라 시작할 때 경고가 한 줄 나온다.

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { RestoredCard, ApprovalStatus } from '../src/lib/agentProtocol.ts'
import { config } from './config.ts'

export type { ApprovalStatus }
export type Card = RestoredCard

export interface StoredCard {
  sessionId: string
  // 이 카드가 몇 번째 사용자 메시지(0부터)의 응답에 붙는지. 대화 복원 때 위치를 정한다.
  turn: number
  card: Card
}

export interface AuditEntry {
  at: string
  user: string
  sessionId: string
  approvalId: string
  // Docker Agent tool_call_confirmation의 tool_call.id
  toolCallId: string
  tool: string
  decision: ApprovalStatus
}

if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })
const db = new DatabaseSync(config.dbPath)

db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT    NOT NULL,
    turn        INTEGER NOT NULL,
    approval_id TEXT    UNIQUE,
    status      TEXT,
    body        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cards_session ON cards(session_id);

  CREATE TABLE IF NOT EXISTS approval_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    user        TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    approval_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    tool        TEXT NOT NULL,
    decision    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- 사이드바 맨 위에 고정한 대화. Docker Agent의 starred는 목록 응답에 없어서 WEB이 따로 둔다.
  CREATE TABLE IF NOT EXISTS pins (
    session_id TEXT PRIMARY KEY,
    pinned_at  TEXT NOT NULL
  );

  -- 턴마다 쓴 토큰과 비용(Docker Agent snapshot의 턴 전후 차이). 대화를 지워도 남겨서 전체 사용량을 센다.
  CREATE TABLE IF NOT EXISTS usage_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT    NOT NULL,
    session_id    TEXT    NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost          REAL    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_usage_at ON usage_log(at);
`)

// v0.2.x(Airlock) 때 만든 파일은 열 이름만 바꾼다.
const auditColumns = db.prepare('PRAGMA table_info(approval_audit)').all().map((c) => c.name)
if (auditColumns.includes('airlock_id')) db.exec('ALTER TABLE approval_audit RENAME COLUMN airlock_id TO tool_call_id')

const insertCard = db.prepare(
  'INSERT INTO cards (session_id, turn, approval_id, status, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
)
const updateStatus = db.prepare('UPDATE cards SET status = ? WHERE approval_id = ?')
const deleteCardsStmt = db.prepare('DELETE FROM cards WHERE session_id = ?')
const selectCards = db.prepare('SELECT turn, status, body FROM cards WHERE session_id = ? ORDER BY id')
const insertAudit = db.prepare(
  'INSERT INTO approval_audit (at, user, session_id, approval_id, tool_call_id, tool, decision) VALUES (?, ?, ?, ?, ?, ?, ?)',
)

// 상태는 status 열이 기준이다. body에는 카드의 나머지 내용을 JSON으로 둔다.
export function addCard(sessionId: string, turn: number, card: Card): void {
  const approvalId = card.kind === 'approval' ? card.approvalId : null
  const status = card.kind === 'approval' ? card.status : null
  insertCard.run(sessionId, turn, approvalId, status, JSON.stringify(card), new Date().toISOString())
}

// 대화를 지우면 카드와 고정도 지운다. 승인 감사 기록(approval_audit)은 남긴다.
export function deleteCards(sessionId: string): void {
  deleteCardsStmt.run(sessionId)
  setPinned(sessionId, false)
}

// 대화를 복제하면 복사한 턴(beforeTurn 앞)의 카드도 새 대화로 옮겨 적는다. 대기 중이던 카드는 취소로 둔다.
export function copyCards(from: string, to: string, beforeTurn: number): void {
  for (const { turn, card } of cardsFor(from)) {
    if (turn >= beforeTurn) continue
    if (card.kind === 'approval') {
      // approval_id는 UNIQUE라 복사본에는 새 ID를 붙인다. 복사본 카드는 다시 결정할 수 없다.
      const copy: Card = { ...card, approvalId: `${card.approvalId}_copy_${to.slice(0, 8)}`, status: card.status === 'pending' ? 'cancelled' : card.status }
      addCard(to, turn, copy)
    } else {
      addCard(to, turn, card)
    }
  }
}

// ---- 고정한 대화 ----

export function pinnedSessions(): Set<string> {
  return new Set(db.prepare('SELECT session_id FROM pins').all().map((r) => r.session_id as string))
}

export function setPinned(sessionId: string, pinned: boolean): void {
  if (pinned) {
    db.prepare('INSERT OR IGNORE INTO pins (session_id, pinned_at) VALUES (?, ?)').run(sessionId, new Date().toISOString())
  } else {
    db.prepare('DELETE FROM pins WHERE session_id = ?').run(sessionId)
  }
}

// ---- 승인 기록(설정 화면) ----

export function recentDecisions(limit: number, sessionId?: string): AuditEntry[] {
  const rows = sessionId
    ? db.prepare('SELECT * FROM approval_audit WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit)
    : db.prepare('SELECT * FROM approval_audit ORDER BY id DESC LIMIT ?').all(limit)
  return rows.map((r) => ({
    at: r.at as string,
    user: r.user as string,
    sessionId: r.session_id as string,
    approvalId: r.approval_id as string,
    toolCallId: r.tool_call_id as string,
    tool: r.tool as string,
    decision: r.decision as ApprovalStatus,
  }))
}

// 감사 기록의 approvalId로 카드 내용(요약·대상)을 찾는다. 대화를 지웠으면 없다.
export function cardSummaries(approvalIds: string[]): Map<string, { summary: string; target?: string }> {
  const out = new Map<string, { summary: string; target?: string }>()
  const stmt = db.prepare('SELECT body FROM cards WHERE approval_id = ?')
  for (const id of approvalIds) {
    const row = stmt.get(id)
    if (!row) continue
    const card = JSON.parse(row.body as string) as Card
    if (card.kind === 'approval') out.set(id, { summary: card.summary, ...(card.action.target ? { target: card.action.target } : {}) })
  }
  return out
}

export function updateApprovalCard(approvalId: string, status: ApprovalStatus): void {
  updateStatus.run(status, approvalId)
}

// 한 대화에서 from~to 사이에 만든 승인 카드. 삭제 전 백업이 실제 삭제로 이어졌는지 짝지을 때 쓴다(server/backups.ts).
export function approvalCardsBetween(sessionId: string, from: string, to: string): { status: ApprovalStatus; card: Card }[] {
  return db
    .prepare('SELECT status, body FROM cards WHERE session_id = ? AND approval_id IS NOT NULL AND created_at >= ? AND created_at <= ? ORDER BY id')
    .all(sessionId, from, to)
    .map((row) => ({ status: row.status as ApprovalStatus, card: JSON.parse(row.body as string) as Card }))
}

// ---- 사용량(설정의 정보 화면) ----

export interface UsageSum {
  inputTokens: number
  outputTokens: number
  cost: number
}

export function logUsage(sessionId: string, usage: UsageSum): void {
  db.prepare('INSERT INTO usage_log (at, session_id, input_tokens, output_tokens, cost) VALUES (?, ?, ?, ?, ?)').run(
    new Date().toISOString(),
    sessionId,
    usage.inputTokens,
    usage.outputTokens,
    usage.cost,
  )
}

// since(ISO 시각) 이후 합계. 없으면 전체.
export function usageSince(since?: string): UsageSum {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o, COALESCE(SUM(cost), 0) AS c FROM usage_log WHERE at >= ?',
    )
    .get(since ?? '')
  return { inputTokens: Number(row?.i ?? 0), outputTokens: Number(row?.o ?? 0), cost: Number(row?.c ?? 0) }
}

export function cardsFor(sessionId: string): StoredCard[] {
  return selectCards.all(sessionId).map((row) => {
    const card = JSON.parse(row.body as string) as Card
    if (card.kind === 'approval') card.status = row.status as ApprovalStatus
    return { sessionId, turn: row.turn as number, card }
  })
}

// 백엔드가 다시 켜지면 기다리던 도구 호출이 없으므로 대기 중이던 카드는 취소로 바꾼다.
// Docker Agent 쪽 대기 건은 Agent 스트림이 끊길 때 Agent가 취소한다.
export function cancelPendingCards(): number {
  return Number(db.prepare("UPDATE cards SET status = 'cancelled' WHERE status = 'pending'").run().changes)
}

export function logDecision(entry: Omit<AuditEntry, 'at'>): void {
  const row = { at: new Date().toISOString(), ...entry }
  insertAudit.run(row.at, row.user, row.sessionId, row.approvalId, row.toolCallId, row.tool, row.decision)
  console.info('[audit]', JSON.stringify(row))
}

// 설정 화면 값. 지금은 고른 모델(`model`)만 둔다.
export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? (row.value as string) : undefined
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  )
}
