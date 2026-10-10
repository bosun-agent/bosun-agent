import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthGate } from './components/AuthGate'
import { usingMock } from './lib/agent'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 목업에는 백엔드가 없으므로 로그인 없이 띄운다 */}
    {usingMock ? <App /> : <AuthGate>{(onLogout) => <App onLogout={onLogout} />}</AuthGate>}
  </StrictMode>,
)
