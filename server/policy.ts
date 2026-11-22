// 설정 > 정책에서 작업을 허용·묻기·막기 칸으로 옮기는 기능(2026-11-11 회의, 11-14 사용자: 위험과 상관없이 자유롭게 옮기는 것이 목표).
// - 사용자가 기본값에서 바꾼 항목만 WEB 저장소(settings 표)에 둔다.
// - Agent를 켤 때마다(agentProcess.ts) Agent 설정 파일(agent.yaml)의 permissions에 그 항목만 바꿔 적는다.
//   Agent 담당이 기준 파일을 다시 만들어도 다음에 켤 때 사용자 선택이 다시 들어간다.
// - 바꾼 것이 없으면 파일을 건드리지 않는다. 기본값으로 되돌리면 처음 파일(기준) 그대로 돌려놓는다.
// - Docker Agent는 deny → allow → ask 순서로 맞추고, 셋 다 아니면 safety(strict)에 따라 묻는다.
//   패턴의 `*`는 `/`까지 아무 글자나 맞춘다(docker-agent v1.148.0 pkg/permissions/permissions.go).
// - 정책 훅(ai-agent-hooks/tool_input_transform_direct_policy_guard.py ALLOW)이 허용하지 않는 작업은 permissions를 바꿔도
//   훅이 막으므로 잠근다. 훅이 사용자 선택을 읽게 되면(시원 님 작업) 풀 수 있다.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Document, isMap, isScalar, isSeq, parseDocument, Scalar, YAMLSeq } from 'yaml'
import type { PolicyBucket, PolicyItem, PolicyState } from '../src/lib/agentProtocol.ts'
import { config } from './config.ts'
import { getSetting, setSetting } from './store.ts'

export const BUCKETS: readonly PolicyBucket[] = ['allow', 'ask', 'deny']

interface CatalogItem {
  id: string
  label: string
  group: string
  // 옮길 때 넣고 빼는 패턴. 기준 파일에 있는 것과 글자가 같아야 뺄 수 있다.
  patterns?: string[]
  // 잠긴 항목은 기준 파일에서 이 식에 맞는 패턴을 모아 보여주기만 한다.
  match?: RegExp
  // hook: 정책 훅이 막는다. fixed: 화면에 안 보이는 내부 규칙(백업 2단계, 인코딩 우회 막기).
  lock?: 'hook' | 'fixed'
}

const proxy = (method: string, path: string) => `docker_proxy:method=${method}:path=${path}`

// 순서가 화면 순서다.
const CATALOG: CatalogItem[] = [
  { id: 'docker_info', label: 'Docker 상태·디스크 사용량', group: '조회', patterns: ['/_ping', '/version', '/info', '/system/df'].map((p) => proxy('GET', p)) },
  { id: 'env_list', label: '환경 목록', group: '조회', patterns: ['EndpointList'] },
  { id: 'container_list', label: '컨테이너 목록', group: '조회', patterns: [proxy('GET', '/containers/json')] },
  { id: 'container_stats', label: 'CPU·메모리 사용량', group: '조회', patterns: [proxy('GET', '/containers/*/stats')] },
  { id: 'container_inspect', label: '컨테이너 상세', group: '조회', patterns: [proxy('GET', '/containers/*/json')] },
  { id: 'container_logs', label: '컨테이너 로그', group: '조회', patterns: [proxy('GET', '/containers/*/logs*')] },
  { id: 'container_top', label: '컨테이너 안 프로그램 목록', group: '조회', patterns: [proxy('GET', '/containers/*/top*')] },
  { id: 'image_list', label: '이미지 목록', group: '조회', patterns: [proxy('GET', '/images/json')] },
  { id: 'image_inspect', label: '이미지 상세·이력', group: '조회', patterns: [proxy('GET', '/images/*/json'), proxy('GET', '/images/*/history')] },
  { id: 'volume_list', label: '볼륨 목록', group: '조회', patterns: [proxy('GET', '/volumes')] },
  { id: 'volume_inspect', label: '볼륨 상세', group: '조회', patterns: [proxy('GET', '/volumes/*')] },
  { id: 'network_list', label: '네트워크 목록', group: '조회', patterns: [proxy('GET', '/networks')] },
  { id: 'network_inspect', label: '네트워크 상세', group: '조회', patterns: [proxy('GET', '/networks/*')] },
  { id: 'stack_list', label: '스택 목록', group: '조회', patterns: ['StackList'] },
  { id: 'stack_file', label: '스택 설정 파일(Compose) 보기', group: '조회', patterns: ['StackFileInspect'] },
  { id: 'backup_status', label: '백업 결과 조회', group: '조회', patterns: ['backup_status'] },

  { id: 'container_start', label: '컨테이너 시작', group: '컨테이너', patterns: [proxy('POST', '/containers/*/start')] },
  { id: 'container_stop', label: '컨테이너 중지', group: '컨테이너', patterns: [proxy('POST', '/containers/*/stop')] },
  { id: 'container_restart', label: '컨테이너 재시작', group: '컨테이너', patterns: [proxy('POST', '/containers/*/restart')] },
  { id: 'container_delete', label: '정지된 컨테이너 삭제', group: '컨테이너', patterns: [proxy('DELETE', '/containers/*')] },
  { id: 'image_pull', label: '공식 이미지 받기', group: '이미지', patterns: [proxy('POST', '/images/create')] },
  { id: 'stack_create', label: '스택 만들기', group: '스택', patterns: ['StackCreateDockerStandaloneString'] },
  { id: 'stack_update', label: '스택 수정', group: '스택', patterns: ['StackUpdate'] },
  { id: 'stack_start', label: '스택 시작', group: '스택', patterns: ['StackStart'] },
  { id: 'stack_stop', label: '스택 중지', group: '스택', patterns: ['StackStop'] },
  // 11-18: 스택 삭제는 정책표 수정본(11-13)에서 ASK. 볼륨까지 지우면 정책 훅이 최근 백업을 확인한다.
  { id: 'stack_delete', label: '스택 삭제', group: '스택', patterns: ['StackDelete'] },
  // 11-18: 볼륨·네트워크 삭제도 11-13부터 ASK(볼륨은 최근 백업 필수, 네트워크는 연결된 컨테이너가 없을 때만 — 정책 훅 검사)
  { id: 'volume_delete', label: '볼륨 삭제', group: '볼륨·네트워크', patterns: [proxy('DELETE', '/volumes/*')] },
  { id: 'network_delete', label: '네트워크 삭제', group: '볼륨·네트워크', patterns: [proxy('DELETE', '/networks/*')] },
  // 11-18: "지금 백업"은 exec가 아니라 soteria backup_volume(11-12 팀 결정 "exec 예외 허용 X")
  { id: 'backup_volume', label: '지금 볼륨 백업', group: '백업', patterns: ['backup_volume'] },

  { id: 'container_create', label: '컨테이너 직접 생성', group: '컨테이너', match: /containers\/create/, lock: 'hook' },
  { id: 'pause', label: '일시정지·재개', group: '컨테이너', match: /pause/, lock: 'hook' },
  // 11-12부터 예외 없이 막는다("docker_proxy:path=*/exec*"). 옛 설정의 백업 2단계(/exec/*/start)는 아래 내부 규칙이 가져간다.
  { id: 'exec', label: '컨테이너 안 명령 실행', group: '컨테이너', match: /\/exec(?!\/)/, lock: 'hook' },
  { id: 'archive', label: '컨테이너 안 파일 읽기·쓰기', group: '컨테이너', match: /archive/, lock: 'hook' },
  { id: 'export', label: '컨테이너 파일시스템 내보내기', group: '컨테이너', match: /\/export/, lock: 'hook' },
  { id: 'image_delete', label: '이미지 삭제', group: '이미지', match: /method=DELETE:path=\*\/images/, lock: 'hook' },
  { id: 'image_search', label: '이미지 검색', group: '이미지', match: /images\/search/, lock: 'hook' },
  { id: 'image_export', label: '이미지 내보내기(tar)', group: '이미지', match: /images\/get|images\/\*\/get/, lock: 'hook' },
  { id: 'network_change', label: '네트워크 생성·연결·해제', group: '볼륨·네트워크', match: /networks\/(create|\*\/connect|\*\/disconnect)/, lock: 'hook' },
  { id: 'prune', label: '일괄 정리(prune)', group: '볼륨·네트워크', match: /prune/, lock: 'hook' },

  { id: 'backup_exec_start', label: '옛 백업 실행 2단계(11-12 전 설정)', group: '내부', match: /path=\/exec\/\*\/start$/, lock: 'fixed' },
  { id: 'encoded_path', label: '인코딩된 경로로 규칙 피하기', group: '내부', match: /path=\*%\*$/, lock: 'fixed' },
]

const RAW_PREFIX = 'raw:'
const CHOICES_KEY = 'policy.choices'
const fileKey = (file: string) => `policy.file.${file}`

type Lists = Record<PolicyBucket, string[]>

// ---- 설정 파일 위치 ----

// AGENT_CONFIG가 폴더면 그 안의 yaml 전부(초보자용·숙련자용), 파일이면 그 파일, 없으면 AGENT_ENV_FILE 옆 <AGENT_NAME>.yaml.
export function policyFiles(): string[] {
  const target = config.agentConfig || (config.agentEnvFile ? join(dirname(config.agentEnvFile), `${config.agentName}.yaml`) : '')
  if (!target || !existsSync(target)) return []
  if (!statSync(target).isDirectory()) return [target]
  return readdirSync(target)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort()
    .map((f) => join(target, f))
}

// ---- 패턴 목록 읽기·바꾸기 ----

function seqOf(doc: Document, bucket: PolicyBucket): YAMLSeq | undefined {
  const node = doc.getIn(['permissions', bucket], true)
  return isSeq(node) ? node : undefined
}

function listsOf(doc: Document): Lists {
  const lists = { allow: [], ask: [], deny: [] } as Lists
  for (const b of BUCKETS) {
    for (const node of seqOf(doc, b)?.items ?? []) if (isScalar(node) && typeof node.value === 'string') lists[b].push(node.value)
  }
  return lists
}

function parse(text: string): Document {
  const doc = parseDocument(text)
  if (doc.errors.length) throw new Error(`YAML 오류: ${doc.errors[0].message}`)
  return doc
}

function bucketOf(lists: Lists, patterns: string[]): PolicyBucket | undefined {
  return BUCKETS.find((b) => lists[b].some((p) => patterns.includes(p)))
}

// 옮길 수 있는 항목의 패턴(예: 볼륨 삭제)은 잠긴 항목 식에 걸려도 그쪽에 넣지 않는다.
const MOVABLE = new Set(CATALOG.flatMap((c) => c.patterns ?? []))

function lockedPatterns(lists: Lists, item: CatalogItem): string[] {
  return BUCKETS.flatMap((b) => lists[b]).filter((p) => !MOVABLE.has(p) && item.match!.test(p))
}

// 기준 파일의 패턴 목록으로 화면 항목을 만든다. 어느 항목에도 안 맞는 패턴은 원문 그대로 옮길 수 있는 항목이 된다.
function itemsOf(lists: Lists): (PolicyItem & { patterns: string[] })[] {
  const claimed = new Set<string>()
  const items: (PolicyItem & { patterns: string[] })[] = []
  for (const c of CATALOG) {
    if (c.lock) {
      const found = lockedPatterns(lists, c)
      found.forEach((p) => claimed.add(p))
      if (!found.length || c.lock === 'fixed') continue
      const bucket = bucketOf(lists, found) ?? 'ask'
      items.push({ id: c.id, label: c.label, group: c.group, bucket, defaultBucket: bucket, lock: 'hook', patterns: found })
      continue
    }
    const patterns = c.patterns!
    patterns.forEach((p) => claimed.add(p))
    const bucket = bucketOf(lists, patterns) ?? 'ask'
    items.push({ id: c.id, label: c.label, group: c.group, bucket, defaultBucket: bucket, ...(c.group !== '조회' ? { change: true } : {}), patterns })
  }
  for (const b of BUCKETS) {
    for (const p of lists[b]) {
      if (claimed.has(p)) continue
      claimed.add(p)
      // 무엇을 하는 규칙인지 모르므로 바꾸는 작업으로 본다(허용으로 옮길 때 확인).
      items.push({ id: RAW_PREFIX + p, label: p, group: '그 밖의 규칙', bucket: b, defaultBucket: b, raw: true, change: true, patterns: [p] })
    }
  }
  return items
}

// 기준 파일 글에 사용자 선택을 적용한 글. 바꿀 것이 없으면 기준 그대로 돌려준다(다시 쓰지 않아 주석·모양이 그대로 남는다).
export function applyChoices(baseText: string, choices: Record<string, PolicyBucket>): string {
  const doc = parse(baseText)
  const moves = itemsOf(listsOf(doc)).filter((it) => !it.lock && choices[it.id] && choices[it.id] !== it.defaultBucket)
  if (!moves.length) return baseText
  if (!isMap(doc.get('permissions', true))) doc.set('permissions', doc.createNode({}))
  for (const it of moves) {
    for (const b of BUCKETS) {
      const seq = seqOf(doc, b)
      if (seq) seq.items = seq.items.filter((n) => !(isScalar(n) && typeof n.value === 'string' && it.patterns.includes(n.value)))
    }
    const to = choices[it.id]
    let seq = seqOf(doc, to)
    if (!seq) {
      seq = new YAMLSeq()
      doc.setIn(['permissions', to], seq)
    }
    for (const p of it.patterns) {
      const node = new Scalar(p)
      node.type = 'QUOTE_DOUBLE'
      seq.items.push(node)
    }
  }
  const out = spliceSection(baseText, doc)
  check(out, baseText)
  return out
}

// permissions 부분만 새로 쓰고 나머지 글자는 그대로 둔다. 문서 전체를 다시 쓰면 긴 명령 줄이 접히고 주석 자리가 바뀐다.
function spliceSection(baseText: string, doc: Document): string {
  const root = doc.contents
  const pair = isMap(root) ? root.items.find((p) => isScalar(p.key) && p.key.value === 'permissions') : undefined
  const section = new Document({}, { keepSourceTokens: false })
  section.set('permissions', pair?.value ?? doc.get('permissions', true))
  const text = section.toString({ lineWidth: 0 }).replace(/\n+$/, '')
  const keyRange = isScalar(pair?.key) ? pair.key.range : undefined
  const valueRange = (pair?.value as { range?: [number, number, number] } | undefined)?.range
  if (!keyRange || !valueRange) return `${baseText.replace(/\n*$/, '\n\n')}${text}\n`
  // range[2]는 값 뒤에 붙은 주석까지 포함한다(그 주석도 위 text에 다시 찍힌다).
  const end = baseText.slice(0, valueRange[2]).replace(/\s+$/, '').length
  return baseText.slice(0, keyRange[0]) + text + baseText.slice(end)
}

// 쓴 글이 다시 읽히고 모양이 맞는지. 틀리면 파일을 쓰지 않는다(Agent가 못 뜨는 것을 막는다).
function check(out: string, baseText: string): void {
  const doc = parse(out)
  const perms = doc.get('permissions', true)
  if (!isMap(perms)) throw new Error('permissions가 없어요.')
  for (const b of BUCKETS) {
    const node = perms.get(b, true)
    if (node !== undefined && !(isSeq(node) && node.items.every((n) => isScalar(n) && typeof n.value === 'string'))) {
      throw new Error(`permissions.${b}가 글자 목록이 아니에요.`)
    }
  }
  const base = parse(baseText)
  for (const key of ['agents', 'models']) {
    if (base.has(key) && !doc.has(key)) throw new Error(`${key}가 사라졌어요.`)
  }
}

// ---- 저장 ----

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

// 11/22: 사용자가 정책 칸에서 '금지'로 옮긴 항목 중 이 도구에 해당하는 것의 이름. Docker Agent의 permissions 거부 문구에는
// 도구 이름만 있어서(docker_proxy는 어느 경로인지 모름) 그 도구의 사용자 금지 항목을 모두 돌려준다. 없으면 빈 배열(기본 정책·훅 거부).
export function userDeniedFor(tool: string): string[] {
  const choices = savedChoices()
  return CATALOG.filter((c) => choices[c.id] === 'deny' && c.patterns?.some((p) => p === tool || p.startsWith(`${tool}:`))).map((c) => c.label)
}

export function savedChoices(): Record<string, PolicyBucket> {
  try {
    const raw = JSON.parse(getSetting(CHOICES_KEY) ?? '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, PolicyBucket] => BUCKETS.includes(e[1] as PolicyBucket)))
  } catch {
    return {}
  }
}

interface FileRecord {
  base: string
  written: string
}

function fileRecord(file: string): FileRecord | undefined {
  try {
    const rec = JSON.parse(getSetting(fileKey(file)) ?? 'null') as FileRecord | null
    return rec && typeof rec.base === 'string' && typeof rec.written === 'string' ? rec : undefined
  } catch {
    return undefined
  }
}

// 기준 글: WEB이 마지막으로 쓴 그대로면 저장해 둔 기준, 누가 바꿨거나 처음이면 지금 파일.
function baseOf(file: string, current: string): string {
  const rec = fileRecord(file)
  return rec && rec.written === sha(current) ? rec.base : current
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.web-tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

// 모든 설정 파일에 사용자 선택을 적용한다. 하나라도 실패하면 아무 파일도 쓰지 않는다.
export function applyPolicy(choices: Record<string, PolicyBucket> = savedChoices()): { changed: string[] } {
  const plans = policyFiles().map((file) => {
    const current = readFileSync(file, 'utf8')
    const base = baseOf(file, current)
    return { file, current, base, out: applyChoices(base, choices) }
  })
  const changed: string[] = []
  for (const { file, current, base, out } of plans) {
    // 처음부터 바꾼 것이 없으면 기록도 남기지 않는다.
    if (out === current && (out === base || fileRecord(file)?.written === sha(current))) continue
    if (out !== current) {
      writeAtomic(file, out)
      changed.push(file)
    }
    setSetting(fileKey(file), JSON.stringify({ base, written: sha(out) }))
  }
  return { changed }
}

// ---- 화면 ----

export function policyState(): PolicyState {
  const files = policyFiles()
  if (!files.length) {
    return { editable: false, reason: 'Agent 설정 파일을 찾지 못했어요(AGENT_CONFIG·AGENT_ENV_FILE).', files: [], items: [], changed: 0 }
  }
  let lists: Lists
  try {
    lists = listsOf(parse(baseOf(files[0], readFileSync(files[0], 'utf8'))))
  } catch (err) {
    return { editable: false, reason: `Agent 설정 파일을 읽지 못했어요: ${(err as Error).message}`, files: files.map(nameOf), items: [], changed: 0 }
  }
  const choices = savedChoices()
  const items = itemsOf(lists).map(({ patterns: _p, ...it }) => {
    const chosen = !it.lock ? choices[it.id] : undefined
    return chosen ? { ...it, bucket: chosen } : it
  })
  return { editable: true, files: files.map(nameOf), items, changed: items.filter((it) => it.bucket !== it.defaultBucket).length }
}

function nameOf(file: string): string {
  return file.split(/[\\/]/).pop()!
}

// 화면이 보낸 칸 배치를 검사해서 기본값과 다른 것만 남긴다. 잠긴 항목·모르는 항목은 받지 않는다.
export function choicesFrom(value: unknown): Record<string, PolicyBucket> | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '칸 배치가 올바르지 않아요.'
  const state = policyState()
  if (!state.editable) return state.reason ?? '정책을 바꿀 수 없어요.'
  const byId = new Map(state.items.map((it) => [it.id, it]))
  const out: Record<string, PolicyBucket> = {}
  for (const [id, bucket] of Object.entries(value)) {
    const item = byId.get(id)
    if (!item) return `모르는 항목이에요: ${id}`
    if (!BUCKETS.includes(bucket as PolicyBucket)) return `칸 이름이 올바르지 않아요: ${String(bucket)}`
    if (item.lock && bucket !== item.defaultBucket) return `정책 훅이 막는 항목은 옮길 수 없어요: ${item.label}`
    if (!item.lock && bucket !== item.defaultBucket) out[id] = bucket as PolicyBucket
  }
  return out
}

// 저장하고 파일에 적용한다. 적용하지 못하면 이전 선택으로 되돌린다.
export function savePolicy(choices: Record<string, PolicyBucket>): { changed: string[] } {
  const before = getSetting(CHOICES_KEY) ?? '{}'
  setSetting(CHOICES_KEY, JSON.stringify(choices))
  try {
    return applyPolicy(choices)
  } catch (err) {
    setSetting(CHOICES_KEY, before)
    throw err
  }
}
