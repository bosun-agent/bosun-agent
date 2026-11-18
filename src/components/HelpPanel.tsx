import { useEffect, useState } from 'react'
import type { PolicyBucket, PolicyState } from '../lib/agentProtocol'
import { agent } from '../lib/agent'
import { EXAMPLE_PROMPTS, type ExamplePrompt } from '../lib/examples'

// 무엇을 물어볼 수 있는지 보여주는 도움말. 예시를 누르면 입력창에 채운다(보내지는 않는다).
// 설정 > 정책 칸(GET /api/policy)을 읽을 수 있으면 세 목록을 그 칸대로 만든다(2026-11-14). 못 읽으면(목업, 설정 파일 없음)
// 아래 고정 글을 보여 준다. 실제 판정은 Agent 정책이 하므로 이 표가 틀려도 막히는 것은 막힌다.

type Group = { title: string; tone: string; desc: string; items: string[] }

// 정책 칸과 상관없이 정책 훅(허용 목록·스택 검사)이 늘 막는 것. 칸에는 없어서 따로 적는다.
const ALWAYS_BLOCKED = [
  '권한 상승(privileged), 호스트 폴더·호스트 네트워크 연결',
  '비밀번호·토큰을 설정에 적기(비밀번호가 꼭 필요한 앱은 관리자에게 요청해요)',
  '시작 명령 바꾸기(entrypoint, 정해진 것 밖의 command·healthcheck)',
  '이름 없는 볼륨을 쓰는 DB 앱 수정(데이터를 옮겨야 해서 관리자에게 요청해요)',
  'Docker Hub 공식 이미지가 아닌 이미지 쓰기',
  '실행 중인 컨테이너 강제 삭제',
  '최근 백업 없이 볼륨 지우기(스택과 함께 지울 때도 같아요)',
  '앱이 쓰고 있는 볼륨만 따로 지우기(앱과 함께 지워요)',
  '데이터 복원(관리자가 복원 도구로 해요. 관리자에게 요청하세요)',
]

// 정책 칸 이름만으로는 빠지는 조건(정책 훅이 검사한다). 11-19 도움말에서 조건이 사라져 있었다.
const ITEM_HINT: Record<string, string> = {
  stack_delete: '볼륨까지 지우면 최근 백업이 있어야 해요',
  volume_delete: '최근 백업이 있어야 해요',
  network_delete: '연결된 컨테이너가 없을 때만',
}

// "컨테이너: 컨테이너 시작, 컨테이너 중지"처럼 묶음 이름이 항목마다 반복되지 않게 앞말을 뺀다.
function shortLabel(group: string, label: string): string {
  return label.startsWith(`${group} `) ? label.slice(group.length + 1) : label
}

const COLUMN_GROUP: Record<PolicyBucket, { title: string; tone: string; desc: string }> = {
  allow: { title: '바로 실행돼요', tone: 'text-neutral-700', desc: '설정 > 정책의 허용 칸이에요. 승인 카드 없이 실행돼요.' },
  ask: {
    title: '승인을 받고 실행돼요',
    tone: 'text-amber-700',
    desc: '노란 승인 카드가 뜨고, 승인해야 실행돼요. 5분 안에 결정하지 않으면 취소돼요. 설정 > 정책에서 허용 칸으로 옮기면 바로 실행돼요.',
  },
  deny: { title: '채팅으로는 할 수 없어요', tone: 'text-red-700', desc: '보안 정책으로 막혀 있어요. 빨간 차단 안내가 나와요.' },
}

// 칸마다 "묶음: 항목, 항목" 한 줄씩
function groupsFromPolicy(policy: PolicyState): Group[] {
  return (['allow', 'ask', 'deny'] as const).map((bucket) => {
    const items = policy.items.filter((it) => it.bucket === bucket)
    const lines = [...new Set(items.map((it) => it.group))].map((g) => {
      const labels = items
        .filter((it) => it.group === g)
        .map((it) => (ITEM_HINT[it.id] ? `${shortLabel(g, it.label)}(${ITEM_HINT[it.id]})` : shortLabel(g, it.label)))
      return g === '그 밖의 규칙' ? `그 밖의 규칙 ${labels.length}개` : `${g}: ${labels.join(', ')}`
    })
    return { ...COLUMN_GROUP[bucket], items: bucket === 'deny' ? [...lines, ...ALWAYS_BLOCKED] : lines.length ? lines : ['없어요'] }
  })
}

const GROUPS: Group[] = [
  {
    title: '바로 실행돼요',
    tone: 'text-neutral-700',
    desc: '바뀌는 것이 없는 목록 조회예요.',
    items: ['환경·스택 목록', '컨테이너·이미지·볼륨·네트워크 목록', '네트워크 상세', 'CPU·메모리 사용량', '백업 결과'],
  },
  {
    title: '승인을 받고 실행돼요',
    tone: 'text-amber-700',
    desc: '노란 승인 카드가 뜨고, 승인해야 실행돼요. 5분 안에 결정하지 않으면 취소돼요.',
    items: [
      '컨테이너 로그·상세·프로그램 목록, 이미지·볼륨 상세',
      '컨테이너 시작·정지·재시작',
      '정지된 컨테이너 삭제(삭제 전에 설정을 저장해요. 실행 중이면 먼저 정지해요)',
      '새 앱(스택) 만들기, 스택 수정·켜기·끄기(DB처럼 데이터를 남기는 앱은 이름 있는 볼륨을 붙여 만들어요)',
      '이미지 받기(Docker Hub 공식 이미지만)',
      '스택 삭제, 볼륨 삭제(최근 백업이 있어야 해요), 네트워크 삭제(연결된 컨테이너가 없을 때만)',
      '지금 볼륨 백업',
    ],
  },
  {
    title: '채팅으로는 할 수 없어요',
    tone: 'text-red-700',
    desc: '보안 정책으로 막혀 있어요. 빨간 차단 안내가 나와요.',
    items: [
      '컨테이너를 직접 만들기(새 앱은 스택으로 만들어요)',
      '컨테이너 안에서 명령 실행',
      '컨테이너 안 파일 읽기·내보내기, 이미지 내보내기',
      '일괄 정리(prune), 강제 종료, 일시정지',
      '이미지 삭제, 네트워크 만들기·연결',
      '권한 상승(privileged), 호스트 폴더·호스트 네트워크 연결',
      '비밀번호·토큰을 설정에 적기(비밀번호가 꼭 필요한 앱은 관리자에게 요청해요)',
      '시작 명령 바꾸기(entrypoint, 정해진 것 밖의 command·healthcheck)',
      '이름 없는 볼륨을 쓰는 DB 앱 수정(데이터를 옮겨야 해서 관리자에게 요청해요)',
      '최근 백업 없이 볼륨 지우기',
      '앱이 쓰고 있는 볼륨만 따로 지우기(앱과 함께 지워요)',
      '데이터 복원(관리자가 복원 도구로 해요. 관리자에게 요청하세요)',
    ],
  },
]

const EXAMPLE_TAG: Record<PolicyBucket, { tag: string; cls: string }> = {
  allow: { tag: '', cls: 'border-neutral-200 text-neutral-700' },
  ask: { tag: '승인 · ', cls: 'border-navy-100 text-navy-700' },
  deny: { tag: '막힘 · ', cls: 'border-red-100 text-red-700' },
}

const KIND_BUCKET: Record<ExamplePrompt['kind'], PolicyBucket> = { auto: 'allow', approval: 'ask', blocked: 'deny' }

export function HelpPanel({ onClose, onPick }: { onClose: () => void; onPick: (text: string) => void }) {
  const [policy, setPolicy] = useState<PolicyState | null>(null)
  useEffect(() => {
    agent.getPolicy?.().then(
      (p) => setPolicy(p.editable ? p : null),
      () => undefined,
    )
  }, [])
  const groups = policy ? groupsFromPolicy(policy) : GROUPS
  const bucketOf = (item?: string) => policy?.items.find((it) => it.id === item)?.bucket

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="도움말"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-[-0.012em]">무엇을 할 수 있나요?</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="도움말 닫기"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100"
          >
            ✕
          </button>
        </div>
        <p className="mb-3 text-sm text-neutral-600">
          평소 말로 요청하면 돼요. AI가 Portainer를 통해 Docker를 조회하고, 바꾸는 작업은 승인을 받은 뒤에 실행해요.
        </p>

        <div className="space-y-3">
          {groups.map((g) => (
            <section key={g.title}>
              <h3 className={`text-sm font-semibold ${g.tone}`}>{g.title}</h3>
              <p className="text-xs text-neutral-500">{g.desc}</p>
              <ul className="mt-1 list-outside list-disc space-y-0.5 pl-5 text-sm text-neutral-700">
                {g.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <h3 className="mt-4 text-sm font-semibold">예시 (누르면 입력창에 채워요)</h3>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {EXAMPLE_PROMPTS.map((p) => {
            const tag = EXAMPLE_TAG[bucketOf(p.item) ?? KIND_BUCKET[p.kind]]
            return (
              <button
                key={p.text}
                type="button"
                onClick={() => onPick(p.text)}
                className={`rounded-full border px-3 py-1 text-xs hover:bg-neutral-100 ${tag.cls}`}
              >
                {tag.tag}
                {p.text}
              </button>
            )
          })}
        </div>

        <h3 className="mt-4 text-sm font-semibold">화면 사용법</h3>
        <ul className="mt-1 list-outside list-disc space-y-0.5 pl-5 text-sm text-neutral-700">
          <li>처리 중에는 입력창 오른쪽 ■ 버튼으로 멈출 수 있어요. 승인 대기 중인 카드도 취소돼요.</li>
          <li>대화는 여러 개를 동시에 돌릴 수 있어요. 처리 중인 대화는 목록에 노란 점이 보여요.</li>
          <li>보낸 메시지에 마우스를 올리면 '수정'이 보여요. 고쳐 보내면 그 앞까지 복사한 새 대화에서 다시 시작해요.</li>
          <li>입력창 왼쪽 + 버튼으로 compose·로그 같은 텍스트 파일을 붙일 수 있어요(파일당 50KB까지).</li>
          <li>새로고침하거나 창을 닫아도 처리는 계속돼요. 다시 열면 이어서 보여요.</li>
        </ul>
      </div>
    </div>
  )
}
