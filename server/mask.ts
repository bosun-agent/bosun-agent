// 브라우저로 나가는 문자열에서 알려진 비밀값 형식을 가린다(계약 5장 4항).
// 1차 방어는 Agent 프롬프트 규칙이고 이건 보조 장치다. text_delta는 조각 단위로 가리므로
// 비밀값이 두 조각에 걸쳐 오면 놓칠 수 있다.

const MASK = '••••'

const PATTERNS: [RegExp, string][] = [
  // Portainer API 키
  [/ptr_[A-Za-z0-9+/=_-]{8,}/g, MASK],
  // JWT
  [/eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g, MASK],
  // Authorization 헤더 값
  [/(Bearer\s+)[\w.~+/-]{8,}=*/gi, `$1${MASK}`],
  // password=..., TOKEN: ... 같은 키-값
  [/((?:password|passwd|pwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, `$1${MASK}`],
]

export function maskText(text: string): string {
  return PATTERNS.reduce((s, [re, to]) => s.replace(re, to), text)
}
