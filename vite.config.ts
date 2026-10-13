import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // 공개 데모는 GitHub Pages 하위 경로에도 올릴 수 있게 상대 경로로 빌드한다.
  base: mode === 'demo' ? './' : '/',
  plugins: [react(), tailwindcss()],
  server: {
    // npm run dev:http일 때 화면의 /api 요청을 WEB 백엔드(npm run server)로 넘긴다.
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
}))
