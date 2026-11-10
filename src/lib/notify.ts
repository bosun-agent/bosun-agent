// 다른 탭을 보고 있을 때 승인 카드가 뜨면 알린다. 탭 제목은 항상 바꾸고, 브라우저 알림은 설정에서 켰을 때만 띄운다.
// 설정 값은 이 브라우저에만 둔다(localStorage). 막혀 있어도 화면은 그대로 동작한다.

const KEY = 'bosun.notify'
const BASE_TITLE = document.title

export function notifyEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === '1' && 'Notification' in window && Notification.permission === 'granted'
  } catch {
    return false
  }
}

// 켜려면 브라우저 권한이 필요하다. 거절하면 false.
export async function setNotifyEnabled(on: boolean): Promise<boolean> {
  try {
    if (!on) {
      localStorage.setItem(KEY, '0')
      return true
    }
    if (!('Notification' in window)) return false
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
    if (permission !== 'granted') return false
    localStorage.setItem(KEY, '1')
    return true
  } catch {
    return false
  }
}

let flagged = false

function restoreTitle() {
  if (!flagged || document.hidden) return
  flagged = false
  document.title = BASE_TITLE
}
document.addEventListener('visibilitychange', restoreTitle)
window.addEventListener('focus', restoreTitle)

export function notifyApproval(summary: string): void {
  if (!document.hidden) return
  flagged = true
  document.title = `(승인 필요) ${BASE_TITLE}`
  if (!notifyEnabled()) return
  try {
    const n = new Notification('BOSUN: 승인이 필요해요', { body: summary, tag: 'bosun-approval' })
    n.onclick = () => {
      window.focus()
      n.close()
    }
  } catch {
    // 알림을 띄우지 못해도 탭 제목은 바뀌어 있다.
  }
}
