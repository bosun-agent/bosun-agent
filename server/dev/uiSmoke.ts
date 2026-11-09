// 화면 스모크 테스트. 브라우저로 첫 화면부터 승인·멈춤·다시 붙기·설정 화면까지 눌러 본다.
// 실행: npm run server:fake, npm run server, npm run dev:http를 띄운 뒤 npm run test:ui
// 운영 빌드(STATIC_DIR=dist)로 확인하려면 URL=http://127.0.0.1:3001/ npm run test:ui
// 브라우저는 설치된 Chrome을 쓴다(CHROME_PATH). 캡처를 남기려면 SHOTS=<폴더>.
import { chromium } from 'playwright-core'

const OUT = process.env.SHOTS
const URL = process.env.URL ?? 'http://localhost:5173/'
let failures = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++
  console.info(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail ?? '')}`)
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
const page = await ctx.newPage()
const errors: string[] = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))
const shot = async (name: string) => {
  if (OUT) await page.screenshot({ path: `${OUT}/${name}.png` })
}
const input = () => page.getByPlaceholder('무엇을 해 드릴까요?')
async function send(text: string) {
  await input().fill(text)
  await input().press('Enter')
}
async function openSidebar() {
  await page.getByLabel('대화 목록 열기').or(page.getByLabel('대화 목록 닫기')).first().waitFor()
  if (await page.getByLabel('대화 목록 열기').isVisible()) await page.getByLabel('대화 목록 열기').click()
}
async function newChat() {
  await openSidebar()
  await page.getByRole('button', { name: '+ 새 대화' }).click()
}

// 로그인 없이 바로 Home
await page.goto(URL)
await input().waitFor()
const logo = page.getByRole('img', { name: 'BOSUN' })
check('로그인 없이 바로 Home', (await logo.isVisible()) && !(await page.getByText('로그인').count()))
check('첫 화면 로고 이미지가 실제로 불러와진다', await logo.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0))

// 예시 버튼 → 입력창 채우기
await page.getByRole('button', { name: '실행 중인 컨테이너 목록 보여줘' }).click()
check('예시를 누르면 입력창이 채워진다', (await input().inputValue()) === '실행 중인 컨테이너 목록 보여줘')
await input().press('Enter')
await page.getByText('실행 중인 컨테이너는 web 하나예요.').waitFor()
check('조회 답', true)
await shot('01-reply')

// 승인 카드(EFFECT 줄, 기술 정보 접힘)
await newChat()
await send('nginx 삭제해줘')
await page.getByText('승인이 필요해요').waitFor()
check('승인 카드에 승인하면 어떻게 되는지 한 줄', await page.getByText('컨테이너와 그 안에서 바뀐 파일이 지워져요', { exact: false }).isVisible())
check('삭제 카드 위에 되돌릴 수 없음 표시', await page.getByText('되돌릴 수 없음', { exact: true }).isVisible())
check('요청 원문은 접혀 있다', !(await page.getByText('DELETE /containers/nginx-web').isVisible()))
await page.getByText('기술 정보 (Docker에 보낼 요청)').click()
check('펼치면 요청 원문', await page.getByText('DELETE /containers/nginx-web').isVisible())
check('승인 대기 중에는 멈춤 버튼', await page.getByLabel('멈추기').isVisible())
await shot('02-approval')

// 다른 대화는 그대로 쓸 수 있다
await newChat()
await send('안녕')
await page.getByText('가짜 Agent 응답이에요', { exact: false }).waitFor()
check('승인 대기 중에도 다른 대화에서 보낼 수 있다', true)

// 새로고침하면 마지막으로 보던 대화가 열린다
await page.reload()
await page.getByText('가짜 Agent 응답이에요', { exact: false }).waitFor()
check('새로고침하면 마지막으로 보던 대화가 다시 열린다', true)

// 대기 중인 카드가 돌아오고 승인할 수 있다
await openSidebar()
await page.getByRole('button', { name: /^nginx 삭제해줘( 처리 중)?$/ }).click()
await page.getByText('승인이 필요해요').waitFor()
check('새로고침 뒤 처리 중 대화에 다시 붙어 카드가 보인다', true)
await page.getByRole('button', { name: '승인', exact: true }).click()
await page.getByText('nginx-web을 삭제했어요.').waitFor()
check('다시 붙은 카드를 승인하면 이어서 답', true)
await page.getByRole('button', { name: /^처리 과정 보기/ }).last().click()
check('처리 과정에 무엇을 승인했는지 남는다', await page.getByText('승인함: 컨테이너 nginx-web 삭제').isVisible())
await shot('03-approved-after-reload')

// 모델이 빈 답을 보내면 멈춘 것처럼 두지 않고 다시 시도를 띄운다
await newChat()
await send('빈 답 테스트')
await page.getByText('AI가 빈 답을 보냈어요', { exact: false }).waitFor()
check('빈 답이면 오류와 다시 시도', await page.getByRole('button', { name: '다시 시도' }).last().isVisible())
check('오류의 다시 시도는 마우스를 올리지 않아도 보인다', (await page.getByRole('button', { name: '다시 시도' }).last().evaluate((el) => getComputedStyle(el.parentElement!).opacity)) === '1')

// 중간에 막힌 뒤 다시 만들어 승인하면 차단 안내가 회색으로 낮아진다(2026-10-28 리허설)
await newChat()
await send('설정 없이 만들어줘')
await page.getByText('승인이 필요해요').waitFor()
check('차단 안내에 무엇이 왜 막혔는지', await page.getByText('컨테이너 생성 body(설정)가 없습니다', { exact: true }).isVisible())
check('승인 전에는 빨간 차단됨', await page.getByText('차단됨', { exact: true }).isVisible())
check(
  '정책 차단이면 Portainer에서 직접 하라는 안내와 링크',
  (await page.getByRole('link', { name: 'Portainer 열기 ↗' }).getAttribute('href')) === 'https://localhost:9443',
)
check('처리 과정에 차단 사유가 붙고 같은 줄은 ×2로', await page.getByText('정책에 따라 차단됨: 컨테이너 생성 body(설정)가 없습니다').isVisible() && (await page.getByText('×2').isVisible()))
await shot('04-blocked')
await page.getByRole('button', { name: '승인', exact: true }).click()
await page.getByText('simple-web을 만들었어요.').waitFor()
check('뒤에 승인한 작업이 있으면 도중에 막힌 요청(회색)', await page.getByText('도중에 막힌 요청', { exact: true }).isVisible() && !(await page.getByText('차단됨', { exact: true }).isVisible()))
check('회색으로 낮추면 Portainer 안내는 뺀다', !(await page.getByRole('link', { name: 'Portainer 열기 ↗' }).isVisible()))
await shot('05-blocked-resolved')

// 먼저 뜬 카드를 기다리는 사이 다른 대화가 같은 대상을 바꾸면, 승인해도 실행하지 않고 처리 과정과 답 아래 안내로 알린다
await newChat()
await send('nginx 지워줘')
await page.getByText('승인이 필요해요').waitFor()
{
  // 다른 대화는 API로 보내고 승인한다. 화면처럼 X-Bosun 헤더를 붙인다.
  const headers = { 'X-Bosun': '1' }
  const { sessionId } = (await (await page.request.post(`${URL}api/sessions`, { headers })).json()) as { sessionId: string }
  const sent = await (await page.request.post(`${URL}api/sessions/${sessionId}/messages`, { headers, data: { text: 'nginx 지워줘' } })).text()
  const approvalId = /"approvalId":"([^"]+)"/.exec(sent)?.[1]
  await page.request.post(`${URL}api/sessions/${sessionId}/approvals/${approvalId}`, { headers, data: { decision: 'approve' } })
}
await page.getByRole('button', { name: '승인', exact: true }).click()
await page.getByText('승인되지 않아서 삭제하지 않았어요.').waitFor()
const changedShown = async () => {
  await page.getByRole('button', { name: /^처리 과정 보기/ }).last().click()
  return (
    (await page.getByText('다른 대화에서 같은 대상', { exact: false }).isVisible()) &&
    (await page.getByText('대상이 바뀌어 실행 안 함: 컨테이너 nginx-web 삭제').isVisible()) &&
    !(await page.getByText('승인함: 컨테이너 nginx-web 삭제').isVisible()) &&
    !(await page.getByText('차단됨', { exact: true }).isVisible())
  )
}
check('대상이 바뀌어 실행하지 않았으면 승인함 대신 그 줄과 안내(정책 차단 안내는 없음)', await changedShown())
await shot('06-target-changed')
await page.reload()
await page.getByText('승인되지 않아서 삭제하지 않았어요.').waitFor()
check('새로고침해도 같은 줄과 안내', await changedShown())

// 멈추기
await newChat()
await send('천천히 답해줘')
await page.getByText('1번째 줄이에요.').waitFor()
await page.getByLabel('멈추기').click()
await page.getByText('작업을 멈췄어요.').waitFor()
check('멈추면 안내가 나오고 더 받지 않는다', !(await page.getByText('15번째 줄이에요.').isVisible()))
check('멈춘 뒤 입력창이 다시 열린다', await input().isEnabled())

// 처리 중 새로고침 → 다시 붙어서 끝까지 받는다
await newChat()
await send('천천히 답해줘')
await page.getByText('2번째 줄이에요.').waitFor()
await page.reload()
await openSidebar()
await page.getByRole('button', { name: /^천천히 답해줘( 처리 중)?$/ }).first().click()
await page.getByText('15번째 줄이에요.').waitFor({ timeout: 10_000 })
check('처리 중에 새로고침해도 다시 붙어 끝까지 받는다', await page.getByText('1번째 줄이에요.').isVisible())

// 메시지 수정 → 새 대화
const bubble = page.getByText('천천히 답해줘', { exact: true }).last()
await bubble.hover()
await page.getByRole('button', { name: '수정' }).last().click()
await page.getByLabel('메시지 고치기').fill('컨테이너 목록 보여줘')
await page.getByRole('button', { name: '새 대화로 보내기' }).click()
await page.getByText('실행 중인 컨테이너는 web 하나예요.').last().waitFor()
await openSidebar()
const rows = (re: RegExp) => page.getByRole('button', { name: re }).count()
check(
  '첫 메시지를 고쳐 보내면 그 문장을 제목으로 한 새 대화가 생기고 원래 대화는 남는다',
  (await rows(/^컨테이너 목록 보여줘( 처리 중)?$/)) === 1 && (await rows(/^천천히 답해줘( 처리 중)?$/)) === 2,
  [await rows(/^컨테이너 목록 보여줘( 처리 중)?$/), await rows(/^천천히 답해줘( 처리 중)?$/)],
)
// 서버 제목도 바뀌어서 목록을 다시 받아도 그대로다.
await page.reload()
await openSidebar()
await page.getByRole('button', { name: /^컨테이너 목록 보여줘( 처리 중)?$/ }).waitFor()
check('고친 대화의 제목은 서버에도 저장된다', true)
await shot('04-forked')

// 사이드바: 이름 바꾸기, 고정, 찾기
const row = page.getByRole('button', { name: '안녕', exact: true })
await row.hover()
await page.getByLabel('안녕 이름 바꾸기').click()
await page.getByLabel('대화 제목').fill('인사 대화')
await page.getByLabel('대화 제목').press('Enter')
await page.getByRole('button', { name: '인사 대화', exact: true }).hover()
await page.getByLabel('인사 대화 고정', { exact: true }).click()
check('고정하면 고정됨 묶음에 들어간다', await page.getByText('고정됨').isVisible())
await page.getByLabel('대화 찾기').fill('인사')
const visibleRows = await page.locator('aside nav > div').count()
check('찾기로 걸러진다', visibleRows === 1, visibleRows)
await shot('05-sidebar')
await page.getByLabel('대화 찾기').fill('')

// 새로고침해도 이름과 고정이 남는다(서버 저장)
await page.reload()
await openSidebar()
await page.getByRole('button', { name: '인사 대화', exact: true }).waitFor()
check('이름과 고정이 서버에 저장된다', await page.getByText('고정됨').isVisible())

// 설정 화면
await page.getByLabel('대화 목록 닫기').click()
await page.getByLabel('설정').click()
await page.getByRole('button', { name: '정책' }).click()
await page.getByText('자동 허용 (승인 없이 실행)').waitFor()
check('정책: 자동 허용·거부 규칙 설명', (await page.getByText('조회(GET 요청)').isVisible()) && (await page.getByText('컨테이너 안 명령 실행(exec)').isVisible()))
await shot('06-policy')
await page.getByRole('button', { name: '승인 기록' }).click()
await page.getByText('nginx 삭제', { exact: false }).first().waitFor().catch(() => {})
check('승인 기록에 방금 승인한 카드', await page.getByText('컨테이너 nginx-web 삭제').first().isVisible())
await page.getByRole('button', { name: '백업' }).click()
await page.getByText('지우기 직전에 Agent 백업 훅이', { exact: false }).waitFor()
check('백업 화면', true)
await page.getByRole('button', { name: '정보' }).click()
await page.getByText('v1.148.0-fake').waitFor()
await page.getByRole('button', { name: '확인하기' }).click()
await page.getByText('2개').waitFor()
check('정보: Agent 버전과 도구 수', true)
await page.getByText('켜져 있음(WEB이 띄우지 않음)').waitFor()
check('정보: Agent 실행 상태(AGENT_BIN 없음), 다시 시작 버튼 없음, 배너 없음', (await page.getByRole('button', { name: '다시 시작' }).count()) === 0 && (await page.getByRole('status').count()) === 0)
await shot('07-info')
await page.getByRole('button', { name: '모델' }).click()
await page.getByLabel('더할 모델').fill('openrouter/test/extra')
await page.getByRole('button', { name: '더하기' }).click()
await page.getByText('openrouter/test/extra').waitFor()
check('모델을 더할 수 있다', true)
await page.getByRole('button', { name: '빼기' }).click()
await page.getByText('openrouter/test/extra').waitFor({ state: 'detached' })
check('더한 모델을 뺄 수 있다', true)
check('설정에 계정 탭이 없다', (await page.getByRole('button', { name: '계정' }).count()) === 0)
await page.getByRole('button', { name: '알림' }).click()
check('알림 화면', await page.getByText('승인이 필요하면 브라우저 알림 보내기').isVisible())
await page.getByLabel('설정 닫기').click()

// 도움말
await page.getByLabel('첨부').click()
await page.getByText('무엇을 할 수 있나요?').click()
check('도움말에 안 되는 것 목록', await page.getByText('채팅으로는 할 수 없어요').isVisible())
await shot('08-help')
await page.getByLabel('도움말 닫기').click()

// 스택 배포 카드: 서비스 요약은 보이고 compose 원문은 접혀 있다(환경변수 값은 가림)
await newChat()
await send('스택 배포해줘')
await page.getByText('승인이 필요해요').waitFor()
check('스택 배포 카드 제목과 새로 만듦', (await page.getByText('스택 shop 배포', { exact: true }).isVisible()) && (await page.getByText('새로 만듦', { exact: true }).isVisible()))
check('compose 원문은 접혀 있다', !(await page.getByText('POSTGRES_PASSWORD: ••••', { exact: false }).isVisible()))
await page.getByText('compose 파일 보기').click()
check('펼치면 환경변수 값을 가린 compose', await page.getByText('POSTGRES_PASSWORD: ••••', { exact: false }).isVisible())
await shot('11-stack-card')
await page.getByRole('button', { name: '거부' }).click()
await page.getByText('승인되지 않아서 스택을 만들지 않았어요.').waitFor()

// 승인 방식: 묻지 않기(YOLO) → 재시작은 카드 없이 실행되고 처리 과정에 남는다
await page.getByLabel('설정', { exact: true }).click()
await page.getByRole('button', { name: '정책' }).click()
await page.getByRole('radio', { name: /매번 묻기/ }).waitFor()
check('승인 방식은 두 가지', (await page.getByRole('radio').count()) === 2, await page.getByRole('radio').count())
page.once('dialog', (d) => void d.accept())
await page.getByRole('radio', { name: /묻지 않기/ }).check()
await page.getByRole('radio', { name: /묻지 않기/ }).and(page.locator(':checked')).waitFor()
await shot('12-approval-mode')
await page.getByLabel('설정 닫기').click()
check('묻지 않기면 입력창 위에 늘 보인다', await page.getByText('묻지 않기(YOLO) 켜짐', { exact: false }).isVisible())
await newChat()
await send('web 재시작해줘')
await page.getByText('web을 재시작했어요.').waitFor()
check('재시작은 승인 카드 없이 실행', !(await page.getByText('승인이 필요해요').isVisible()))
check('접힌 처리 과정에 자동 승인 건수', await page.getByText('자동 승인 1건', { exact: false }).isVisible())
await page.getByText('처리 과정 보기', { exact: false }).last().click()
check('펼치면 자동 승인함 줄', await page.getByText('자동 승인함: 컨테이너 web 재시작').isVisible())
await shot('13-auto-approved')
await page.getByLabel('설정', { exact: true }).click()
await page.getByRole('button', { name: '정책' }).click()
await page.getByRole('radio', { name: /매번 묻기/ }).check()
await page.getByRole('radio', { name: /매번 묻기/ }).and(page.locator(':checked')).waitFor()
await page.getByRole('button', { name: '승인 기록' }).click()
await page.getByText('자동 승인', { exact: false }).first().waitFor()
check('승인 기록에 자동 승인으로 남는다', true)
await page.getByLabel('설정 닫기').click()
check('매번 묻기로 돌리면 표시가 사라진다', !(await page.getByText('묻지 않기(YOLO) 켜짐', { exact: false }).isVisible()))

// 여러 개 골라 지우기: 모두 선택은 고정한 대화를 빼고 고른다
await openSidebar()
await page.getByRole('button', { name: '선택', exact: true }).click()
await page.getByLabel('모두 선택').check()
page.once('dialog', (d) => void d.accept())
await page.getByRole('button', { name: /^삭제 \(\d+개\)$/ }).click()
// 고르는 중에도 제목은 보이므로, 사이드바에서 지운 제목이 사라질 때까지 기다린다.
// waitForFunction은 화면의 CSP(script-src 'self')에 막혀서 로케이터로 기다린다.
await page.locator('aside nav', { hasText: '인사 대화', hasNotText: '천천히 답해줘' }).waitFor()
check(
  '여러 개 골라 지우면 고정한 대화만 남는다',
  (await page.getByRole('button', { name: '인사 대화', exact: true }).isVisible()) && (await rows(/^컨테이너 목록 보여줘( 처리 중)?$/)) === 0,
)
await shot('10-bulk-delete')
await page.getByLabel('대화 목록 닫기').click()

// 좁은 화면
await page.setViewportSize({ width: 375, height: 760 })
await shot('09-mobile')
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
check('360px대 화면에서 가로 스크롤 없음', !overflow)

check('콘솔 오류 없음', errors.length === 0, errors)
await browser.close()
console.info(failures ? `${failures} failure(s)` : 'all passed')
process.exit(failures ? 1 : 0)
