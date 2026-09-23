// 라이트/다크/시스템 테마. <html>에 dark 클래스를 붙였다 뗐다 하고, 선택은 localStorage에 저장한다.
// 첫 화면 깜빡임을 막으려고 index.html의 인라인 스크립트도 같은 규칙(키 이름 포함)으로 먼저 적용한다.

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'bosun-theme'
const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)')

export function getStoredTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark') return value
  } catch {
    // 시크릿 창 등에서 저장소 접근이 막혀도 시스템 설정으로 동작
  }
  return 'system'
}

export function storeTheme(theme: Theme) {
  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // 저장 실패 시 이번 방문 동안만 적용
  }
}

export function applyTheme(theme: Theme) {
  const isDark = theme === 'dark' || (theme === 'system' && darkQuery().matches)
  document.documentElement.classList.toggle('dark', isDark)
}

// 시스템 모드일 때 OS 설정이 바뀌면 따라간다. 해제 함수를 돌려준다.
export function watchSystemTheme(onChange: () => void) {
  const query = darkQuery()
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
