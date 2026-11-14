// SSE 응답 본문을 이벤트 단위로 읽는다. 브라우저 클라이언트와 WEB 백엔드가 같이 쓴다.
// Docker Agent와 WEB 백엔드 모두 이벤트 하나를 `data: <JSON>` 한 줄 + 빈 줄로 보낸다.
// `: ping` 주석 줄과 `id:` 줄은 버린다.

export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r', '')
      let end: number
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (data) yield JSON.parse(data)
      }
    }
  } finally {
    reader.releaseLock()
  }
}
