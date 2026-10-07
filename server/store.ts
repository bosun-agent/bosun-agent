// WEB 고유 데이터: 승인·차단 카드와 승인 감사 기록(계약 7.1).
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
  airlockId: string
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
    airlock_id  TEXT NOT NULL,
    tool        TEXT NOT NULL,
    decision    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

const insertCard = db.prepare(
  'INSERT INTO cards (session_id, turn, approval_id, status, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
)
const updateStatus = db.prepare('UPDATE cards SET status = ? WHERE approval_id = ?')
const selectCards = db.prepare('SELECT turn, status, body FROM cards WHERE session_id = ? ORDER BY id')
const insertAudit = db.prepare(
  'INSERT INTO approval_audit (at, user, session_id, approval_id, airlock_id, tool, decision) VALUES (?, ?, ?, ?, ?, ?, ?)',
)

// 상태는 status 열이 기준이다. body에는 카드의 나머지 내용을 JSON으로 둔다.
export function addCard(sessionId: string, turn: number, card: Card): void {
  const approvalId = card.kind === 'approval' ? card.approvalId : null
  const status = card.kind === 'approval' ? card.status : null
  insertCard.run(sessionId, turn, approvalId, status, JSON.stringify(card), new Date().toISOString())
}

export function updateApprovalCard(approvalId: string, status: ApprovalStatus): void {
  updateStatus.run(status, approvalId)
}

export function cardsFor(sessionId: string): StoredCard[] {
  return selectCards.all(sessionId).map((row) => {
    const card = JSON.parse(row.body as string) as Card
    if (card.kind === 'approval') card.status = row.status as ApprovalStatus
    return { sessionId, turn: row.turn as number, card }
  })
}

// 백엔드가 다시 켜지면 기다리던 도구 호출이 없으므로 대기 중이던 카드는 취소로 바꾼다.
// Airlock 쪽 대기 건은 main.ts의 cleanupPending이 거부한다.
export function cancelPendingCards(): number {
  return Number(db.prepare("UPDATE cards SET status = 'cancelled' WHERE status = 'pending'").run().changes)
}

export function logDecision(entry: Omit<AuditEntry, 'at'>): void {
  const row = { at: new Date().toISOString(), ...entry }
  insertAudit.run(row.at, row.user, row.sessionId, row.approvalId, row.airlockId, row.tool, row.decision)
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
