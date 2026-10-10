import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { currentUser, login, logout, UNAUTHORIZED_EVENT } from '../lib/api'

// 로그인한 관리자에게만 화면을 보여준다(계약 3장). 목업 모드에는 백엔드가 없으므로 쓰지 않는다.
// 로그아웃하거나 로그인이 끝나면 children을 내려서 대화 상태도 같이 비운다.
export function AuthGate({ children }: { children: (onLogout: () => void) => ReactNode }) {
  const [user, setUser] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    currentUser().then((u) => !cancelled && setUser(u), () => !cancelled && setUser(null))
    const onUnauthorized = () => setUser(null)
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => {
      cancelled = true
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    }
  }, [])

  async function handleLogout() {
    await logout()
    setUser(null)
  }

  if (user === undefined) return null
  if (user === null) return <LoginScreen onLogin={setUser} />
  return <>{children(handleLogout)}</>
}

function LoginScreen({ onLogin }: { onLogin: (user: string) => void }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || !username || !password) return
    setBusy(true)
    setError(null)
    const result = await login(username, password)
    setBusy(false)
    if (result.ok) {
      onLogin(username)
    } else {
      setError(result.message)
      setPassword('')
    }
  }

  return (
    <div className="flex h-dvh items-center justify-center bg-white px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-2xl border border-neutral-200 p-6">
        <h1 className="text-xl font-semibold">BOSUN</h1>
        <p className="text-sm text-neutral-500">관리자 계정으로 로그인해주세요.</p>
        <label className="block space-y-1">
          <span className="text-sm text-neutral-600">아이디</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-[15px]"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-neutral-600">비밀번호</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-[15px]"
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-md bg-neutral-900 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          로그인
        </button>
      </form>
    </div>
  )
}
